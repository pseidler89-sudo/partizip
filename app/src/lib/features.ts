/**
 * features.ts — zentrale Feature-Flags (Build-Schalter).
 *
 * Reine Konstanten, ohne "use server"/DB-Bezug — nutzbar in Server-Components,
 * Server-Actions und Client-Components.
 *
 * FEATURE_ANLIEGEN_EINREICHEN:
 *   Das Anliegen-Einreichen ist VOLLSTÄNDIG GEBAUT, aber im Pilot noch nicht
 *   aktiv (Entscheidung Patrick, ADR-014 Punkt 5): Es braucht eine verlässliche
 *   Kuratierung/Moderation und lenkt aktuell vom Mitmach-Kern (Abstimmungen) ab.
 *   Der Code bleibt erhalten — bei false werden lediglich die Einstiegspunkte
 *   (Nav-Link, CTAs, Formular) ausgeblendet und die Server-Action `createAnliegen`
 *   hart gegated. Der reine Tracker (/anliegen, Status per Code) bleibt nutzbar.
 *   Wieder aktivieren: hier auf `true` setzen (siehe Roadmap/ADR-014).
 */
export const FEATURE_ANLIEGEN_EINREICHEN = false;
