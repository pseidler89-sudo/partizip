/**
 * [tenant]/verifizieren/bestaetigen/page.tsx — Verifizierer bestätigt den vom
 * Bürger gezeigten Konto-QR (Verifizierung 2.0, V3, umgekehrte Richtung).
 *
 * SCANNER-/BLOCK-A-HÄRTUNG (konsistent mit Magic-Link / Einladung):
 *   GET  = idempotent, nebenwirkungsfrei. Der Proof-Token wird NUR geprüft
 *          (gültig / verbraucht / abgelaufen / unbekannt) und die Bestätigungs-
 *          seite gerendert. KEIN Verbrauch, KEIN Grant, KEIN Audit.
 *   POST = erst der Klick „Wohnsitz bestätigen" (ProofBestaetigen → Server
 *          Action) konsumiert den Beleg atomar und vergibt Stufe 2.
 *
 * BERECHTIGUNG: NUR canVerify (verifier/kommune_admin/super_admin). Wer das nicht
 * ist, sieht einen NEUTRALEN Hinweis — kein Existenz-Orakel über den Beleg.
 *
 * DATENSCHUTZ: Die Bürger-Identität wird NIE angezeigt (nur die Gültigkeit des
 * Belegs + die Gebiets-Auswahl). referrer: "no-referrer" — der Token steht in
 * der URL und darf nicht abfließen.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers, cookies } from "next/headers";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { getTenantFromHost } from "@/lib/tenant";
import { sessions } from "@/db/schema";
import { sha256Hex } from "@/lib/auth/crypto";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import {
  canVerify,
  getUserRoleTypes,
  getUserRolesMitScope,
  isAdmin,
} from "@/lib/auth/roles";
import {
  proofFuerAnzeige,
  verifierZielGebiete,
  vorbelegtesGebiet,
} from "@/lib/verification/proof-core";
import ProofBestaetigen, { type ProofGebietOption } from "./ProofBestaetigen";
import QrScanner from "./QrScanner";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Wohnsitz bestätigen",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ proof?: string | string[] }>;
}

function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ?? "postgres://partizip:partizip@127.0.0.1:5433/partizip"
  );
}

function Schale({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

export default async function BestaetigenPage({ params, searchParams }: PageProps) {
  const { tenant: slugFromPath } = await params;
  // `?proof=a&proof=b` liefert in Next ein Array — auf den ersten String normalisieren
  // (kein ungeprüfter string[] in den Hash-Lookup).
  const proofRaw = (await searchParams).proof;
  const proofToken = Array.isArray(proofRaw) ? proofRaw[0] : proofRaw;

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost";
  const tenant = await getTenantFromHost(host);
  if (!tenant || tenant.slug !== slugFromPath) notFound();

  const db = createDb(databaseUrl());

  // --- Berechtigung: NUR canVerify. Sonst NEUTRALER Hinweis (kein Orakel) ---
  const cookieStore = await cookies();
  const rawSession = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  let userId: string | null = null;
  if (rawSession) {
    const now = new Date();
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, sha256Hex(rawSession)), eq(sessions.tenantId, tenant.id)))
      .limit(1);
    const session = sessionRows[0];
    if (session && !session.revokedAt && session.expiresAt >= now) {
      userId = session.userId;
    }
  }

  const roleTypes = userId ? await getUserRoleTypes(db, tenant.id, userId) : [];
  if (!userId || !canVerify(roleTypes)) {
    return (
      <Schale>
        <div className="pz-card p-6 text-center">
          <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
            Diese Seite ist für verifizierende Stellen
          </h1>
          <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
            Hier bestätigen Verifizierer:innen den Wohnsitz vor Ort. Wenn Sie sich
            selbst verifizieren möchten, öffnen Sie Ihren persönlichen QR-Code.
          </p>
          <Link
            href={`/${slugFromPath}/verifizieren`}
            className="pz-btn pz-btn-primary mt-4"
          >
            Zur Verifizierung
          </Link>
        </div>
      </Schale>
    );
  }

  // --- Kein Token in der URL → In-App-Scanner (PR-O2) -----------------------
  // Der Auth-Guard oben (canVerify) bleibt vorgeschaltet; erst danach wird der
  // Scanner gerendert. Er ist reines UX-Frontend: er zieht clientseitig den
  // proof-Token und navigiert auf ?proof=<token> — die Server-Prüfung folgt.
  if (!proofToken) {
    return (
      <Schale>
        <QrScanner tenantSlug={slugFromPath} />
      </Schale>
    );
  }

  // --- GET: Beleg NUR prüfen (nicht konsumieren) ---------------------------
  const { status } = await proofFuerAnzeige(db, tenant.id, proofToken);
  if (status !== "gueltig") {
    const text =
      status === "verbraucht"
        ? "Dieser Beleg wurde bereits verwendet."
        : status === "abgelaufen"
          ? "Dieser Beleg ist abgelaufen. Bitte die Person, einen neuen QR zu erzeugen."
          : "Dieser Beleg ist ungültig.";
    return (
      <Schale>
        <div className="pz-card p-6 text-center">
          <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
            Bestätigung nicht möglich
          </h1>
          <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>{text}</p>
          <Link
            href={`/${slugFromPath}/verifizieren/bestaetigen`}
            className="pz-btn pz-btn-primary mt-4"
          >
            Nächsten Code scannen
          </Link>
        </div>
      </Schale>
    );
  }

  // Gebiets-Auswahl: die vom Server berechneten erlaubten Ziel-Gebiete des
  // Verifizierers (Admins: ganze Gemeinde-Scheibe; Nicht-Admin: eigener Knoten
  // + darunter). Nur UI-Komfort — die Durchsetzung liegt serverseitig im Core.
  const scopes = await getUserRolesMitScope(db, tenant.id, userId);
  const feed = await verifierZielGebiete(db, tenant.id, scopes, isAdmin(roleTypes));
  const vorbelegt = vorbelegtesGebiet(feed);
  const gebiete: ProofGebietOption[] = feed.map((g) => ({
    regionId: g.regionId,
    typ: g.typ,
    label: g.label,
  }));

  return (
    <Schale>
      <div className="pz-card p-6">
        <h1 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
          Wohnsitz für dieses Konto bestätigen?
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--pz-body)" }}>
          Prüfen Sie zuerst den Personalausweis. Mit der Bestätigung wird die
          Person wohnsitz-verifiziert (Stufe 2). Aus Datenschutzgründen sehen Sie
          hier keine Kontodaten.
        </p>
        <ProofBestaetigen
          proofToken={proofToken}
          tenantSlug={slugFromPath}
          gebiete={gebiete}
          vorbelegtRegionId={vorbelegt}
        />
      </div>
    </Schale>
  );
}
