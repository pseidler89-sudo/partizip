/**
 * PollStatusChip.tsx — Teilnahme-Status pro Poll-Karte (P1, CANNANAS_EVAL §Empf. 4).
 *
 * SECRET BALLOT (Gate-B-Auflage): zeigt NUR das OB der Teilnahme („Sie haben
 * abgestimmt") — NIE das WIE (die getroffene Wahl). Die zugrunde liegende
 * Batch-Query (hatBereitsAbgestimmtBatch) selektiert ausschließlich poll_id.
 *
 * Wird nur für eingeloggte Nutzer (Stufe ≥ 1) gerendert — der Aufrufer entscheidet
 * das, indem er `abgestimmt` nur dann übergibt. Rein präsentational (keine Hooks).
 */

export default function PollStatusChip({ abgestimmt }: { abgestimmt: boolean }) {
  if (abgestimmt) {
    return (
      <span
        className="pz-badge-success inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
      >
        <span aria-hidden>✓</span> Sie haben abgestimmt
      </span>
    );
  }
  return (
    <span className="pz-badge-neutral inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium">
      Noch offen
    </span>
  );
}
