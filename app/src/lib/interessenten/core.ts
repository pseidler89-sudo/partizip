/**
 * interessenten/core.ts — reine, testbare Bausteine für den Interessenten-Lead
 * (Block N1/N2). BEWUSST OHNE "use server": Validierung, Normalisierung und das
 * Payload-Mapping werden von der Server Action (N1), dem Webhook-Handler (N2)
 * UND den DB-Integrationstests gemeinsam genutzt.
 *
 * SICHERHEIT/PII: Diese Datei berührt Klartext-PII (Name/E-Mail/Nachricht) nur
 * als Werte im Rückgabeobjekt — sie loggt NICHTS. Das PII-freie Auditieren
 * passiert in den Aufrufern (nur { quelle } bzw. id).
 */

import { z } from "zod";
import { emailSchema } from "@/lib/auth/email";

/** Eigener Rate-Limit-Scope für Formular-Leads (getrennt von Login/Anliegen). */
export const INTERESSENT_SCOPE_IP = "interessent_ip";
export const INTERESSENT_SCOPE_EMAIL = "interessent_email";

/** Konservative Grenzwerte (Lead-Formular ist niederfrequent). */
export const INTERESSENT_RATE_LIMITS = {
  IP_WINDOW_MIN: 60,
  IP_MAX: 5,
  EMAIL_WINDOW_MIN: 60,
  EMAIL_MAX: 3,
} as const;

/**
 * Eingabe-Schema des Formulars. `email` wird über emailSchema kanonisiert
 * (trim + lowercase) UND validiert. Leere optionale Felder werden zu undefined
 * normalisiert, damit sie als NULL in die DB gehen (nicht als "").
 */
export const interessentFormularSchema = z.object({
  ansprechpartner: z
    .string()
    .trim()
    .min(2, "Bitte geben Sie einen Namen an.")
    .max(120, "Der Name darf maximal 120 Zeichen haben."),
  email: emailSchema,
  kommune: leerZuUndefined(z.string().trim().max(160, "Höchstens 160 Zeichen.")),
  rolle: leerZuUndefined(z.string().trim().max(80, "Höchstens 80 Zeichen.")),
  groesse: leerZuUndefined(z.string().trim().max(80, "Höchstens 80 Zeichen.")),
  nachricht: leerZuUndefined(z.string().trim().max(2000, "Höchstens 2000 Zeichen.")),
});

export type InteressentFormular = z.infer<typeof interessentFormularSchema>;

/**
 * Baustein für optionale Freitext-Felder: leerer String → undefined (→ NULL in
 * der DB), sonst wird die eigentliche Längen-Regel angewandt.
 */
function leerZuUndefined(inner: z.ZodString) {
  return z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined))
    .pipe(inner.optional());
}

/** Insert-Datensatz für einen Formular-Lead (quelle='formular'). */
export interface InteressentInsert {
  kommune: string | null;
  ansprechpartner: string;
  email: string;
  rolle: string | null;
  groesse: string | null;
  nachricht: string | null;
  quelle: "formular" | "tymeslot";
  tymeslotMeetingUid: string | null;
  terminAm: Date | null;
}

/** Formular-Eingabe → Insert-Datensatz (reine Abbildung, kein Seiteneffekt). */
export function formularZuInsert(data: InteressentFormular): InteressentInsert {
  return {
    kommune: data.kommune ?? null,
    ansprechpartner: data.ansprechpartner,
    email: data.email,
    rolle: data.rolle ?? null,
    groesse: data.groesse ?? null,
    nachricht: data.nachricht ?? null,
    quelle: "formular",
    tymeslotMeetingUid: null,
    terminAm: null,
  };
}

// ---------------------------------------------------------------------------
// N2 — Tymeslot-Webhook: Payload-Mapping (robust gegen fehlende Felder)
// ---------------------------------------------------------------------------

/** Minimal-Sicht auf das Tymeslot-`meeting.created`-Payload (nur was wir mappen). */
export interface TymeslotWebhookBody {
  event?: unknown;
  data?: {
    meeting?: {
      uid?: unknown;
      start_time?: unknown;
      attendee?: {
        name?: unknown;
        email?: unknown;
        company?: unknown;
        message?: unknown;
      };
    };
  };
}

/** Gibt einen getrimmten String zurück, wenn der Wert ein nicht-leerer String ist. */
function optionalString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Bildet ein `meeting.created`-Payload auf einen Insert-Datensatz ab.
 * Fail-soft: fehlt die Pflicht-`attendee.email` ODER die `meeting.uid`, ergibt
 * sich `null` (Aufrufer antwortet dann 2xx OHNE Insert). E-Mail wird über das
 * emailSchema kanonisiert/validiert; schlägt das fehl → ebenfalls `null`.
 */
export function tymeslotZuInsert(body: TymeslotWebhookBody): InteressentInsert | null {
  const meeting = body?.data?.meeting;
  if (!meeting) return null;

  const uid = optionalString(meeting.uid);
  if (!uid) return null;

  const rohEmail = optionalString(meeting.attendee?.email);
  if (!rohEmail) return null;
  const emailParsed = emailSchema.safeParse(rohEmail);
  if (!emailParsed.success) return null;

  // start_time → Date (nur wenn valide). Kein Wurf bei Müll-Werten.
  let terminAm: Date | null = null;
  const rohStart = meeting.start_time;
  if (typeof rohStart === "string" || typeof rohStart === "number") {
    const d = new Date(rohStart);
    if (!Number.isNaN(d.getTime())) terminAm = d;
  }

  // ansprechpartner darf nicht leer sein (NOT NULL) — Fallback neutral, ohne PII-Erfindung.
  const name = optionalString(meeting.attendee?.name) ?? "(ohne Namen)";

  return {
    kommune: optionalString(meeting.attendee?.company),
    ansprechpartner: name,
    email: emailParsed.data,
    rolle: null,
    groesse: null,
    nachricht: optionalString(meeting.attendee?.message),
    quelle: "tymeslot",
    tymeslotMeetingUid: uid,
    terminAm,
  };
}
