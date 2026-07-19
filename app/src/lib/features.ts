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

/**
 * FEATURE_VERIFIER_EINMAL_CODE:
 *   Der vom Verifizierer erzeugte Einmal-QR/-Code („Schnellweg", ADR-014 Block 2)
 *   ist der ALTE Weg. Standard ist inzwischen der umgekehrte Konto-QR (V3): der
 *   Bürger zeigt seinen Beleg, die verifizierende Person scannt ihn. Der
 *   Einmal-Code bleibt nur als Sonderfall gedacht („Verifizierer ohne Kamera").
 *   Bei false wird lediglich die Erstell-UI im Verifizierer-Admin ausgeblendet;
 *   Server-Actions/Core (qr-actions.ts/qr-core.ts) und der Einlöse-Pfad bleiben
 *   unverändert bestehen (dormant), damit ausgehändigte Codes weiter einlösbar
 *   sind und die Funktion jederzeit reaktivierbar ist. Wieder aktivieren: `true`.
 */
export const FEATURE_VERIFIER_EINMAL_CODE = false;
