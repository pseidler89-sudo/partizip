/**
 * DatentransparenzPanel.tsx — „Was wir über Sie wissen — und was nicht" (Block J2c,
 * Teil C). Das Nicht-Wissen ist das Vertrauens-Feature (geheime Wahl).
 *
 * Rein präsentational, statisch. ALLE Aussagen müssen WAHR sein (Fakten-Belege in
 * SPEC_J2C §Fakten):
 *   - votes trägt KEINE user_id, nur ein Pseudonym voter_ref = HMAC(SALT, …) und
 *     die Wahl selbst — getrennt (db/schema.ts votes-Block; voter-ref.ts).
 *   - KEIN ip_hash an der Stimme (M1, Migration 0026).
 *   - Audit-Protokolle sind frei von Klarnamen/E-Mail (nur pseudonyme Referenzen).
 *   - Ehrliche Grenze: die geheime Wahl beruht darauf, dass der Server-Schlüssel
 *     GEHEIM bleibt — bewusst NICHT „mathematisch unmöglich".
 *
 * Tonalität „Sie"; Design-Profil (pz-card). A11y: klare Überschriften.
 */

export function DatentransparenzPanel({ anliegenAktiv }: { anliegenAktiv: boolean }) {
  return (
    <div className="pz-card mt-4 p-4">
      <h3 className="text-sm font-semibold" style={{ color: "var(--pz-ink)" }}>
        Was wir über Sie wissen — und was nicht
      </h3>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {/* Was wir sehen */}
        <section aria-labelledby="dt-sehen">
          <h4
            id="dt-sehen"
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: "var(--pz-muted)" }}
          >
            Was wir sehen
          </h4>
          <ul className="mt-2 space-y-1.5 text-sm" style={{ color: "var(--pz-body)" }}>
            <li>Ihre E-Mail-Adresse</li>
            <li>Ihr Geburtsjahr und -monat (nur zur Ableitung der Volljährigkeit)</li>
            <li>Ihren Anzeige-Wohnort und, falls vorhanden, Ihren verbindlichen Wohnsitz</li>
            <li>Ihren Verifizierungs-Status und etwaige Rollen</li>
            <li>Ihre Benachrichtigungs-Einstellungen</li>
            {anliegenAktiv && <li>Anliegen, die Sie eingereicht haben oder denen Sie folgen</li>}
          </ul>
          <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
            Die vollständige, verbindliche Fassung all dieser Daten liefert Ihr
            Daten-Export oben — das ist die eine Wahrheit.
          </p>
        </section>

        {/* Was wir NICHT sehen können */}
        <section aria-labelledby="dt-nicht">
          <h4
            id="dt-nicht"
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: "var(--pz-muted)" }}
          >
            Was wir <span className="underline underline-offset-2">nicht</span> sehen können
          </h4>
          <ul className="mt-2 space-y-1.5 text-sm" style={{ color: "var(--pz-body)" }}>
            <li>
              <span className="font-medium">Wie Sie abgestimmt haben.</span> Ihre einzelne
              Stimme wird nicht mit Ihrem Konto verknüpft gespeichert: Der Stimm-Datensatz
              enthält keine Konto-Kennung, nur ein Pseudonym (das Doppelstimmen verhindert)
              und die Wahl selbst — voneinander getrennt.
            </li>
            <li>
              <span className="font-medium">Von welchem Gerät oder Anschluss.</span> An der
              Stimme wird keine IP-Adresse gespeichert.
            </li>
            <li>
              <span className="font-medium">Wer im Protokoll steht.</span> Unsere internen
              Protokolle enthalten keine Klarnamen oder E-Mail-Adressen, nur pseudonyme
              Referenzen.
            </li>
          </ul>
          <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
            Ehrlich gesagt: Das Pseudonym entsteht aus Ihrer Konto-Kennung über einen
            geheimen Schlüssel, der nur auf dem Server liegt und nie neben Ihrem Konto
            gespeichert wird. Ihre Wahl bleibt geheim, solange dieser Schlüssel geheim
            bleibt.
          </p>
        </section>
      </div>
    </div>
  );
}
