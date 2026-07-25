/**
 * publish-cli-core.ts — testbare Kern-Orchestrierung des Betreiber-CLI
 * `digest:publish` (scripts/digest-publish.ts).
 *
 * KEIN "use server", KEIN process.exit, KEIN argv, KEINE Konsole: reine
 * Funktion (db + Eingaben rein, strukturiertes Ergebnis raus) — direkt gegen
 * ephemeres PG testbar. Das Skript bleibt ein dünner argv-/Exit-Wrapper.
 *
 * Delegiert bewusst an dieselbe App-Kern-Logik wie die Admin-UI:
 *   - freigebenCore  (SoD/Vier-Augen, ALLOW_SELF_APPROVAL — hier als
 *     allowSelfApproval INJIZIERT, damit Tests es unabhängig von der Env setzen)
 *   - veroeffentlichenCore (atomarer CAS, Demo-Fence, Kanal-Versand)
 * KEIN direkter Status-Write, der die Gates umgeht.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { tenants, users, digests, digestStatements, auditEvents } from "@/db/schema";
import { normalizeEmail } from "@/lib/auth/email";
import { getUserRoleTypes, canFreigeben } from "@/lib/auth/roles";
import { freigebenCore } from "@/lib/digest/freigabe-core";
import { veroeffentlichenCore } from "@/lib/digest/veroeffentlichen-core";
import { MAX_TITLE_CHARS } from "@/lib/digest/validate-draft";

export interface DigestPublishCliInput {
  tenantSlug: string;
  digestId: string;
  actorEmail: string;
  /** Roher Titel (wird getrimmt/validiert); null/undefined ⇒ Titel unverändert. */
  neuerTitel?: string | null;
  /** true ⇒ nur freigeben, NICHT veröffentlichen. */
  nurFreigeben?: boolean;
  /** SoD-Selbstfreigabe erlauben (aus isSelfApprovalAllowed() injiziert). */
  allowSelfApproval: boolean;
}

export interface DigestPublishCliResult {
  ok: boolean;
  error?: string;
  /** true auf dem idempotenten Pfad (Digest war bereits veröffentlicht). */
  bereitsVeroeffentlicht?: boolean;
  /** Durchlaufene Schritte (PII-frei), auch im cli_publish-Audit gespeichert. */
  schritte?: string[];
  actorId?: string;
  tenantName?: string;
  digestId?: string;
}

/**
 * Orchestriert Titel-Korrektur → Aussagen-Prüfstempel (m7) → Freigabe → optional
 * Veröffentlichung → cli_publish-Audit. Fail-fast mit sprechenden Fehlern; die
 * Fehler aus freigebenCore/veroeffentlichenCore werden 1:1 durchgereicht.
 */
export async function digestPublishCli(
  db: Db,
  input: DigestPublishCliInput,
): Promise<DigestPublishCliResult> {
  const { tenantSlug, digestId, actorEmail, nurFreigeben = false, allowSelfApproval } = input;

  // Titel fail-fast validieren (Regeln wie import-draft), BEVOR etwas geschrieben wird.
  let neuerTitel: string | null = null;
  if (input.neuerTitel != null) {
    const trimmed = input.neuerTitel.trim();
    if (trimmed === "") return { ok: false, error: "--titel darf nicht leer sein." };
    if (trimmed.length > MAX_TITLE_CHARS) {
      return {
        ok: false,
        error: `--titel ist zu lang (${trimmed.length} Zeichen, maximal ${MAX_TITLE_CHARS} erlaubt).`,
      };
    }
    neuerTitel = trimmed;
  }

  // --- Tenant auflösen ---------------------------------------------------
  const tenantRows = await db
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .limit(1);
  if (tenantRows.length === 0) {
    return { ok: false, error: `Tenant "${tenantSlug}" nicht gefunden.` };
  }
  const tenant = tenantRows[0];

  // --- Actor auflösen: AKTIVES Admin-Konto im Tenant ---------------------
  const actorRows = await db
    .select({ id: users.id, status: users.accountStatus })
    .from(users)
    .where(and(eq(users.tenantId, tenant.id), eq(users.email, normalizeEmail(actorEmail))))
    .limit(1);
  if (actorRows.length === 0) {
    return {
      ok: false,
      error: `Actor "${actorEmail}" in Tenant "${tenantSlug}" nicht gefunden (muss sich zuerst per Magic-Link eingeloggt haben).`,
    };
  }
  if (actorRows[0].status !== "active") {
    return { ok: false, error: `Actor-Konto ist nicht aktiv (Status: ${actorRows[0].status}).` };
  }
  const actorId = actorRows[0].id;

  const roleTypes = await getUserRoleTypes(db, tenant.id, actorId);
  if (!canFreigeben(roleTypes)) {
    return {
      ok: false,
      error:
        `Actor "${actorEmail}" ist kein aktiver Admin (kommune_admin/super_admin) im Tenant ` +
        `"${tenantSlug}". Rollen: [${roleTypes.join(", ") || "keine"}].`,
    };
  }

  // --- Digest laden (tenant-scoped) --------------------------------------
  const digestRows = await db
    .select({ id: digests.id, status: digests.status, title: digests.title })
    .from(digests)
    .where(and(eq(digests.id, digestId), eq(digests.tenantId, tenant.id)))
    .limit(1);
  if (digestRows.length === 0) {
    return { ok: false, error: `Digest "${digestId}" nicht gefunden im Tenant "${tenantSlug}".` };
  }
  const digest = digestRows[0];

  const base = { actorId, tenantName: tenant.name, digestId: digest.id };

  // --- Idempotenz: bereits veröffentlicht --------------------------------
  if (digest.status === "veroeffentlicht") {
    return { ok: true, bereitsVeroeffentlicht: true, schritte: [], ...base };
  }

  if (digest.status !== "entwurf" && digest.status !== "freigegeben") {
    return {
      ok: false,
      error:
        `Unerwarteter Digest-Status "${digest.status}". ` +
        "Freigabe/Veröffentlichung nur aus 'entwurf' oder 'freigegeben' möglich.",
    };
  }

  if (neuerTitel !== null && digest.status !== "entwurf") {
    return {
      ok: false,
      error: `--titel ist nur im Status 'entwurf' möglich (Ist-Status: "${digest.status}").`,
    };
  }

  const schritte: string[] = [];

  // =======================================================================
  // Aus 'entwurf': Titel → Aussagen prüfen → freigeben
  // =======================================================================
  if (digest.status === "entwurf") {
    if (neuerTitel !== null) {
      await db.update(digests).set({ title: neuerTitel }).where(eq(digests.id, digest.id));
      schritte.push("titel_korrigiert");
    }

    // Ungeprüfte Aussagen stempeln (m7: NUR isNull(geprueft_at), nie überschreiben).
    const anzahlGeprueft = await db.transaction(async (tx: Db) => {
      const neu = await tx
        .update(digestStatements)
        .set({ geprueftAt: new Date(), geprueftBy: actorId })
        .where(
          and(eq(digestStatements.digestId, digest.id), isNull(digestStatements.geprueftAt)),
        )
        .returning({ id: digestStatements.id });
      await tx.insert(auditEvents).values({
        tenantId: tenant.id,
        actorType: "admin",
        actorRef: actorId,
        action: "digest.statements_geprueft",
        targetType: "digest",
        targetId: digest.id,
        metadata: { digestId: digest.id, anzahl: neu.length },
      });
      return neu.length;
    });
    schritte.push(`statements_geprueft:${anzahlGeprueft}`);

    // Freigeben über die BESTEHENDE Kern-Logik (SoD unverändert).
    const freigabe = await freigebenCore(db, tenant.id, {
      digestId: digest.id,
      callerUserId: actorId,
      callerRoleTypes: roleTypes,
      allowSelfApproval,
    });
    if (!freigabe.ok) {
      return { ok: false, error: freigabe.error, schritte, ...base };
    }
    schritte.push("freigegeben");
  }

  // =======================================================================
  // Veröffentlichen (Default; nurFreigeben lässt es aus)
  // =======================================================================
  if (nurFreigeben) {
    schritte.push("nur_freigeben");
  } else {
    const publish = await veroeffentlichenCore(db, tenant.id, {
      digestId: digest.id,
      callerUserId: actorId,
      callerRoleTypes: roleTypes,
      tenantSlug: tenant.slug,
    });
    if (!publish.ok) {
      return { ok: false, error: publish.error, schritte, ...base };
    }
    schritte.push("veroeffentlicht");
  }

  // Transparenz-Audit: der Weg war das Betreiber-CLI (PII-frei, UUID-actorRef).
  await db.insert(auditEvents).values({
    tenantId: tenant.id,
    actorType: "admin",
    actorRef: actorId,
    action: "digest.cli_publish",
    targetType: "digest",
    targetId: digest.id,
    metadata: { digestId: digest.id, schritte, tenant: tenant.slug },
  });

  return { ok: true, schritte, ...base };
}
