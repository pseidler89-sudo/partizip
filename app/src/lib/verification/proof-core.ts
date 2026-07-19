/**
 * proof-core.ts — Reine DB-Logik der umgekehrten QR-Verifizierung (V3, „Konto-QR").
 *
 * BEWUSST OHNE "use server" und ohne Request-Kontext: nimmt db/tenantId/userId als
 * PARAMETER (wie qr-core / booking-core). Dadurch von den Actions wiederverwendbar
 * UND als ECHTE Funktion in DB-Integrationstests aufrufbar (keine gespiegelte Logik).
 *
 * DIE UMKEHRUNG (V3): Nicht der Verifizierer erzeugt einen QR, den der Bürger
 * scannt — sondern der EINGELOGGTE Bürger erzeugt einen kurzlebigen, EINMALIGEN
 * Konto-Beleg (verification_proofs), zeigt dessen QR/Code vor Ort, und der
 * Verifizierer bestätigt ihn nach Ausweis-Prüfung. Der Verifizierer sieht die
 * Bürger-Identität NIE (die user_id ist nur interner Anker für grantResidency).
 *
 * SICHERHEITS-KERN (Vertrauensprodukt, spiegelt qr-core):
 *   - Token wie Magic-Link: raw Token (CSPRNG) verlässt nie den Server; in der DB
 *     steht NUR sha256Hex(token). Der RAW-Token wird beim Erzeugen GENAU EINMAL
 *     zurückgegeben (für den QR/Code) und danach nie wieder abrufbar.
 *   - Ein aktiver Beleg je Person: Erzeugen invalidiert vorher offene Belege.
 *   - Single-Use + Ablauf: Konsum ist ein atomarer bedingter UPDATE
 *     (consumed_at IS NULL AND expires_at > now()) — race-frei, kein Doppel-Grant.
 *   - Gebiets-Autorität fail-closed: der Ziel-Knoten MUSS im Tenant-Baum liegen
 *     UND (Nicht-Admin) von einem verifier-Scope des Aktors abgedeckt sein.
 *   - Kein Selbst-Hochstufen: Ein Verifizierer kann den EIGENEN Beleg nicht
 *     bestätigen (fail-closed, doppelt geprüft: Vorab + auf dem RETURNING-userId).
 *   - Tenant-Isolation: JEDE Query/jedes Update ist tenant-scoped.
 *
 * KEIN JS-Date in Roh-`sql` — Zeitvergleiche laufen über now() in der DB.
 * grantResidency berechnet den Ablauf via addMonths (gebundener Parameter).
 */

import { and, eq, isNull, gt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  verificationProofs,
  regions,
  ortsteile,
  auditEvents,
} from "@/db/schema";
import { generateRawToken, sha256Hex } from "@/lib/auth/crypto";
import { grantResidency } from "@/lib/verification/qr-core";
import { pfadDecktAb, type RoleScopeRow } from "@/lib/auth/roles";
import { resolveGemeindeRegionId } from "@/lib/region/scope";
import { getRegion } from "@/lib/region/tree";
import { getNachfahren } from "@/lib/region/tree";

/** Kurze Lebensdauer eines Konto-Belegs — er wird direkt vor Ort gezeigt. */
export const PROOF_TTL_MIN = 5;

// ---------------------------------------------------------------------------
// Marker-Fehler (throw im Core, catch in der Aufrufschicht — Muster QrCapError).
// ---------------------------------------------------------------------------

/** Ziel-Gebiet nicht vom Aktor abgedeckt / nicht im Tenant-Baum (fail-closed). */
export class ProofGebietError extends Error {
  constructor() {
    super("Wohnsitz können Sie nur für Ihr eigenes Zuständigkeitsgebiet bestätigen.");
    this.name = "ProofGebietError";
  }
}

/** Beleg beim atomaren Konsum bereits verbraucht/abgelaufen (Race-Rollback). */
export class ProofConsumedError extends Error {
  constructor() {
    super("proof-consumed-or-expired");
    this.name = "ProofConsumedError";
  }
}

/** Verifizierer versucht, den EIGENEN Beleg zu bestätigen (Selbst-Grant). */
export class ProofSelfError extends Error {
  constructor() {
    super("proof-self");
    this.name = "ProofSelfError";
  }
}

// ---------------------------------------------------------------------------
// 1. Bürger: Konto-Beleg erzeugen
// ---------------------------------------------------------------------------

export interface ProofErzeugenResult {
  proofId: string;
  /** RAW-Token — GENAU EINMAL zurückgegeben, danach nie wieder abrufbar. */
  rawToken: string;
  expiresAt: Date;
}

/**
 * Erzeugt einen Konto-Beleg für einen EINGELOGGTEN Bürger (Stufe ≥ 1 — die
 * Action erzwingt das). In EINER Transaktion:
 *   1. Vorher offene Belege dieses Users invalidieren (expires_at = now()) —
 *      idempotent, es gibt zu jedem Zeitpunkt höchstens einen aktiven Beleg.
 *   2. Neuen Beleg einfügen: nur tokenHash + kurze TTL (kein raw Token in der DB).
 *   3. Audit proof.created (PII-frei: nur proofId).
 *
 * Der RAW-Token wird GENAU EINMAL zurückgegeben (für QR/Code) — nie geloggt,
 * nie erneut abrufbar.
 */
export async function meinProofErzeugenCore(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<ProofErzeugenResult> {
  const rawToken = generateRawToken();
  const tokenHash = sha256Hex(rawToken);
  // JS-Date als gebundener Insert-Wert ist unkritisch (Treiber bindet als
  // Parameter); nur in Roh-`sql`-Templates wäre ein JS-Date verboten.
  const expiresAt = new Date(Date.now() + PROOF_TTL_MIN * 60 * 1000);

  return db.transaction(async (tx: Db) => {
    // 1. Alle noch nicht konsumierten Belege dieses Users invalidieren (Ablauf
    //    auf jetzt setzen; DB-now() — kein JS-Date in Roh-SQL). Im Normalfall
    //    bleibt so nur EIN aktiver Beleg je Person; die Invariante ist per
    //    Konvention/Tx gesichert, NICHT per DB-Constraint (bei zwei exakt
    //    gleichzeitigen Erzeugungen könnten kurzzeitig zwei offene Belege
    //    existieren — unkritisch: beide sind single-use und granten dieselbe
    //    Residency an dieselbe Person, zudem pro Konto rate-limitiert).
    await tx
      .update(verificationProofs)
      .set({ expiresAt: sql`now()` })
      .where(
        and(
          eq(verificationProofs.tenantId, tenantId),
          eq(verificationProofs.userId, userId),
          isNull(verificationProofs.consumedAt),
          gt(verificationProofs.expiresAt, sql`now()`),
        ),
      );

    // 2. Neuen Beleg einfügen.
    const [row] = await tx
      .insert(verificationProofs)
      .values({ tenantId, userId, tokenHash, expiresAt })
      .returning({ id: verificationProofs.id, expiresAt: verificationProofs.expiresAt });

    // 3. Audit PII-frei: nur proofId (NIE tokenHash, NIE rawToken, NIE E-Mail).
    await tx.insert(auditEvents).values({
      tenantId,
      actorType: "user",
      actorRef: userId,
      action: "proof.created",
      targetType: "verification_proof",
      targetId: row.id,
      metadata: { proofId: row.id },
    });

    return { proofId: row.id, rawToken, expiresAt: row.expiresAt };
  });
}

// ---------------------------------------------------------------------------
// 2. Verifizierer (GET): Beleg NUR anzeigen (nicht konsumieren, keine Identität)
// ---------------------------------------------------------------------------

export type ProofAnzeigeStatus = "gueltig" | "verbraucht" | "abgelaufen" | "unbekannt";

/**
 * Lädt den Status eines Belegs per tokenHash (tenant-scoped) — NUR fürs Anzeigen
 * (Block-A-Härtung: GET prüft, konsumiert NICHT). Gibt BEWUSST keine user_id und
 * keine Identität zurück (kein Bürger-Existenz-/Identitäts-Orakel). „unbekannt"
 * deckt sowohl „gibt es nicht" als auch „fremder Tenant" ab.
 */
export async function proofFuerAnzeige(
  db: Db,
  tenantId: string,
  rawToken: string,
): Promise<{ status: ProofAnzeigeStatus }> {
  const tokenHash = sha256Hex(rawToken);
  const rows = await db
    .select({
      consumedAt: verificationProofs.consumedAt,
      expiresAt: verificationProofs.expiresAt,
    })
    .from(verificationProofs)
    .where(
      and(
        eq(verificationProofs.tokenHash, tokenHash),
        eq(verificationProofs.tenantId, tenantId),
      ),
    )
    .limit(1);

  const p = rows[0];
  if (!p) return { status: "unbekannt" };
  if (p.consumedAt) return { status: "verbraucht" };
  if (p.expiresAt <= new Date()) return { status: "abgelaufen" };
  return { status: "gueltig" };
}

// ---------------------------------------------------------------------------
// Gebiets-Autorität des Verifizierers (analog K1 / composer-autoritaet)
// ---------------------------------------------------------------------------

/**
 * Deckt der Aktor (Verifizierer/Admin) den Ziel-Knoten `zielPath` ab? REINE
 * Funktion, fail-closed:
 *   - Admin (kommune_admin/super_admin) → true (tenant-weit; die Tenant-Baum-
 *     Bindung wird zusätzlich im Core geprüft).
 *   - sonst: mindestens EINE `verifier`-Rolle, deren ltree-Pfad `zielPath`
 *     abdeckt (Vorfahr-oder-Selbst).
 */
export function verifierGebietErlaubt(
  scopes: RoleScopeRow[],
  istAdmin: boolean,
  zielPath: string,
): boolean {
  if (istAdmin) return true;
  return scopes.some(
    (r) => r.roleType === "verifier" && pfadDecktAb(r.regionPath, zielPath),
  );
}

/** Ein wählbares Ziel-Gebiet der Bestätigungs-UI (server-getriebener Feed). */
export interface VerifierZielGebiet {
  regionId: string;
  typ: "gemeinde" | "ortsteil";
  path: string;
  label: string;
}

/**
 * Der Picker-Feed für die Konto-QR-Bestätigung: welche Gemeinde-/Ortsteil-Knoten
 * darf dieser Verifizierer als Wohnsitz-Anker wählen? Anker = Tenant-Gemeinde-
 * Knoten; Kandidaten = Gemeinde + Nachfahren, gefiltert auf typ ∈ {gemeinde,
 * ortsteil} und auf `verifierGebietErlaubt`. Sortierung: Gemeinde zuerst, dann
 * Ortsteile alphabetisch. Leer, wenn der Baum (noch) nicht geseedet ist.
 *
 * NUR UI-Komfort/Vorbelegung — die Durchsetzung liegt serverseitig im Core
 * (verifizierungPerProofBestaetigenCore prüft die Abdeckung unabhängig).
 */
export async function verifierZielGebiete(
  db: Db,
  tenantId: string,
  scopes: RoleScopeRow[],
  istAdmin: boolean,
): Promise<VerifierZielGebiet[]> {
  const gemeindeId = await resolveGemeindeRegionId(db, tenantId);
  if (!gemeindeId) return [];

  const gemeinde = await getRegion(db, gemeindeId);
  if (!gemeinde || !gemeinde.path) return [];

  const nachfahren = await getNachfahren(db, gemeindeId);
  const kandidaten = [gemeinde, ...nachfahren].filter(
    (r) => r.typ === "gemeinde" || r.typ === "ortsteil",
  );

  const ergebnis: VerifierZielGebiet[] = [];
  for (const r of kandidaten) {
    // `path` ist in Drizzle nullable (Trigger setzt es real immer); als String
    // casten für pfadDecktAb (ltree → text).
    const pfad = r.path ? String(r.path) : null;
    if (!pfad) continue;
    if (!verifierGebietErlaubt(scopes, istAdmin, pfad)) continue;
    ergebnis.push({
      regionId: r.id,
      typ: r.typ as "gemeinde" | "ortsteil",
      path: pfad,
      label: r.name,
    });
  }

  ergebnis.sort((a, b) => {
    if (a.typ !== b.typ) return a.typ === "gemeinde" ? -1 : 1;
    return a.label.localeCompare(b.label, "de");
  });
  return ergebnis;
}

/**
 * Vorbelegung: den feinsten EINDEUTIGEN Knoten wählen. Genau ein Kandidat →
 * dieser. Sonst: gibt es genau EINEN Ortsteil und KEINEN Gemeinde-Knoten (reiner
 * Ortsteil-Verifizierer) → dieser Ortsteil. Sonst der Gemeinde-Knoten (breite,
 * sichere Vorauswahl; feinere Ortsteile bleiben wählbar). Fällt alles aus → null.
 */
export function vorbelegtesGebiet(feed: VerifierZielGebiet[]): string | null {
  if (feed.length === 0) return null;
  if (feed.length === 1) return feed[0].regionId;
  const ortsteile_ = feed.filter((g) => g.typ === "ortsteil");
  const gemeinde = feed.find((g) => g.typ === "gemeinde");
  if (!gemeinde && ortsteile_.length === 1) return ortsteile_[0].regionId;
  if (gemeinde) return gemeinde.regionId;
  return feed[0].regionId;
}

// ---------------------------------------------------------------------------
// 3. Verifizierer (POST): Konto-QR bestätigen → Stufe 2 (atomarer Single-Use)
// ---------------------------------------------------------------------------

/** Gebietsbindungs-Kontext des bestätigenden Verifizierers (wie QrErstellerKontext). */
export interface VerifierKontext {
  isAdmin: boolean;
  scopes: RoleScopeRow[];
}

export interface ProofBestaetigenResult {
  ok: boolean;
  /** Ablauf der Wohnsitz-Verifizierung nach erfolgreicher Bestätigung. */
  verifiedUntil?: Date;
  error?: string;
}

/**
 * Bestätigt den vom Bürger gezeigten Konto-QR → setzt die Person auf Stufe 2.
 * Reihenfolge (fail-closed):
 *   a. Gebiets-Autorität: Ziel-Knoten laden; er MUSS im Tenant-Gemeinde-Baum
 *      liegen und (Nicht-Admin) von einem verifier-Scope abgedeckt sein; nur
 *      Gemeinde-/Ortsteil-Knoten erlaubt (feiner Wohnsitz-Anker). Sonst
 *      ProofGebietError.
 *   b. Vorab-Lookup des Belegs (tenant-scoped) für freundliche Fehler + die
 *      Selbst-Bestätigungs-Sperre (proof.userId === Verifizierer → Ablehnung).
 *   c. In EINER Transaktion: atomarer Single-Use-Konsum (bedingtes UPDATE
 *      RETURNING user_id) → 0 Rows ⇒ bereits konsumiert/abgelaufen ⇒ Rollback.
 *      Selbst-Bestätigung auf dem RETURNING-userId erneut geprüft (race-safe).
 *      Dann grantResidency("qr_konto", zielRegionId/regionTyp/ortsteil?).
 *   d. Audit residency.granted_by_proof (actorRef = Verifizierer; metadata nur
 *      { regionTyp } — kein tokenHash, keine E-Mail, keine choice).
 *
 * Der bestätigende Verifizierer erfährt die Bürger-Identität NICHT über den
 * Rückgabewert (nur ok/verifiedUntil/error).
 */
export async function verifizierungPerProofBestaetigenCore(
  db: Db,
  tenantId: string,
  verifierUserId: string,
  rawToken: string,
  zielRegionId: string,
  caller: VerifierKontext,
): Promise<ProofBestaetigenResult> {
  // --- a. Gebiets-Autorität (fail-closed) --------------------------------
  const zielRows = await db
    .select({
      id: regions.id,
      typ: regions.typ,
      pathLabel: regions.pathLabel,
      path: sql<string>`${regions.path}::text`,
    })
    .from(regions)
    .where(eq(regions.id, zielRegionId))
    .limit(1);
  const ziel = zielRows[0];
  if (!ziel || !ziel.path) throw new ProofGebietError();
  // Nur feine Knoten als Wohnsitz-Anker (Gemeinde/Ortsteil) — analog QR-Einlösung.
  if (ziel.typ !== "gemeinde" && ziel.typ !== "ortsteil") throw new ProofGebietError();

  // Ziel MUSS im Gemeinde-Teilbaum DIESES Tenants liegen (Tenant-Bindung; deckt
  // auch Admins, die sonst „tenant-weit unbeschränkt" wären — kein Cross-Tenant-Grant).
  const gemeindeId = await resolveGemeindeRegionId(db, tenantId);
  const gemeinde = gemeindeId ? await getRegion(db, gemeindeId) : null;
  const gemeindePath = gemeinde?.path ? String(gemeinde.path) : null;
  if (!gemeindePath || !pfadDecktAb(gemeindePath, ziel.path)) throw new ProofGebietError();

  // Nicht-Admin: mindestens ein verifier-Scope muss den Ziel-Knoten abdecken.
  if (!verifierGebietErlaubt(caller.scopes, caller.isAdmin, ziel.path)) {
    throw new ProofGebietError();
  }

  // --- b. Vorab-Lookup + Selbst-Bestätigungs-Sperre ----------------------
  const tokenHash = sha256Hex(rawToken);
  const found = await db
    .select({
      id: verificationProofs.id,
      userId: verificationProofs.userId,
      expiresAt: verificationProofs.expiresAt,
      consumedAt: verificationProofs.consumedAt,
    })
    .from(verificationProofs)
    .where(
      and(
        eq(verificationProofs.tokenHash, tokenHash),
        eq(verificationProofs.tenantId, tenantId),
      ),
    )
    .limit(1);

  const proof = found[0];
  if (!proof) return { ok: false, error: "Dieser Beleg ist ungültig." };
  if (proof.consumedAt) return { ok: false, error: "Dieser Beleg wurde bereits verwendet." };
  if (proof.expiresAt <= new Date()) return { ok: false, error: "Dieser Beleg ist abgelaufen." };

  // Selbst-Bestätigung sperren (Vorab; die harte Garantie ist die Prüfung auf
  // dem RETURNING-userId im atomaren Konsum). Audit PII-frei.
  if (proof.userId === verifierUserId) {
    await db.insert(auditEvents).values({
      tenantId,
      actorType: "user",
      actorRef: verifierUserId,
      action: "proof.self_rejected",
      targetType: "verification_proof",
      targetId: proof.id,
      metadata: { proofId: proof.id },
    });
    return { ok: false, error: "Sie können Ihren eigenen Beleg nicht bestätigen." };
  }

  // --- c. Atomarer Single-Use-Konsum + Grant in EINER Transaktion --------
  try {
    return await db.transaction(async (tx: Db) => {
      const consumed = await tx
        .update(verificationProofs)
        .set({ consumedAt: sql`now()`, consumedBy: verifierUserId })
        .where(
          and(
            eq(verificationProofs.tokenHash, tokenHash),
            eq(verificationProofs.tenantId, tenantId),
            isNull(verificationProofs.consumedAt),
            gt(verificationProofs.expiresAt, sql`now()`),
          ),
        )
        .returning({ userId: verificationProofs.userId, id: verificationProofs.id });

      if (consumed.length === 0) {
        // Inzwischen konsumiert/abgelaufen → throw → Rollback (kein Grant).
        throw new ProofConsumedError();
      }
      const zielUserId = consumed[0].userId;

      // Selbst-Bestätigung race-safe auf dem RETURNING-userId (falls sich der
      // Vorab-Check und der Konsum je unterschieden — hier hart, mit Rollback).
      if (zielUserId === verifierUserId) throw new ProofSelfError();

      // Ortsteil-Anker ableiten (analog qrEinloesenCore): passenden ortsteile-
      // Datensatz über sein normalisiertes Label (regions_ltree_label(code) =
      // regions.path_label) tenant-scoped auflösen.
      let ortsteilId: string | undefined;
      if (ziel.typ === "ortsteil") {
        const ot = await tx
          .select({ id: ortsteile.id })
          .from(ortsteile)
          .where(
            and(
              eq(ortsteile.tenantId, tenantId),
              sql`regions_ltree_label(${ortsteile.code}) = ${ziel.pathLabel}`,
            ),
          )
          .limit(1);
        if (ot[0]) ortsteilId = ot[0].id;
      }

      // Stufe-2 über den gemeinsamen, tenant-scoped Grant (wie QR/Termin).
      const verifiedUntil = await grantResidency(tx, tenantId, zielUserId, "qr_konto", {
        ortsteilId,
        regionId: ziel.id,
        regionTyp: ziel.typ,
      });

      // Audit PII-frei: actorRef = Verifizierer; die Ziel-userId als UUID im
      // targetId ist ok (wie bookingWahrnehmen); metadata nur { regionTyp }.
      await tx.insert(auditEvents).values({
        tenantId,
        actorType: "user",
        actorRef: verifierUserId,
        action: "residency.granted_by_proof",
        targetType: "user",
        targetId: zielUserId,
        metadata: { regionTyp: ziel.typ },
      });

      return { ok: true, verifiedUntil };
    });
  } catch (err) {
    if (err instanceof ProofConsumedError) {
      return { ok: false, error: "Dieser Beleg wurde bereits verwendet oder ist abgelaufen." };
    }
    if (err instanceof ProofSelfError) {
      return { ok: false, error: "Sie können Ihren eigenen Beleg nicht bestätigen." };
    }
    throw err;
  }
}
