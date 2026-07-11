> **Herkunft:** Übernommen aus den autonomen Loop-Iterationen (Ralph/Self-Improvement, `origin/main` b08e8af) und am 2026-06-15 gegen den überparteilich-kommunalen Mitmachen-Pivot bereinigt. Ergänzende Referenz; bei Widerspruch gilt der real gebaute Code + `docs/decisions/`.

> **Pilot-Status (2026-07-02):** Auf **Options-Ebene (ja/nein/enthaltung) implementiert** in `app/src/lib/polls/ergebnis.ts` (`aggregateVotes`/`bestimmeMaskierteOptionen`): primäre + komplementäre Suppression + **Rekonstruktions-Check** (eindeutige Zerlegung der maskierten Summe → volle Suppression; Gate-B H1 2026-07-02) SERVERSEITIG, maskierte Optionen verlassen den Server mit `count/verifiziert/prozent = null`, kein exakter Kleingruppen-Wert aus dem Payload rekonstruierbar (Sweep-Test) (fester k = `K_ANONYMITY_SCHWELLE` = 5; Schwellen-Änderung = Produktentscheidung). **Seit ADR-022 (2026-07-11):** per-Option-Aufschlüsselung erst nach Abstimmungsende (laufende Umfragen liefern nur `gesamt`/`verifiziert`). **Weiter Roadmap:** per-Poll `polls.min_k_anonymity`, Segment-Aufschlüsselungen (PLZ/Ortsteil) nach dem Algorithmus unten.

> **Bekannte Grenzen der Garantie (Gate-B-Review 2026-07-11):** (1) ~~Die Garantie gilt nur
> pro Einzel-Snapshot (Differenzbildung über die Zeit)~~ — **adressiert durch
> [ADR-022](../decisions/ADR-022-aufschluesselung-nach-abstimmungsende.md)** (2026-07-11):
> Solange eine Umfrage läuft, verlässt KEINE per-Option-Aufschlüsselung den Server
> (`aufschluesselungNachSchluss`, serverseitig in `queries.getPollErgebnis` via
> `ohneAufschluesselung`); nur `gesamt`/`verifiziert` auf Poll-Ebene bleiben sichtbar
> (ADR-014). Die Aufschlüsselung erscheint nach Abstimmungsende (`istBeendet`: Status
> `geschlossen` ODER `closesAt` erreicht, deckungsgleich mit der Beleg-Listen-Freigabe)
> als EIN finaler Stand mit k-Suppression — die Snapshot-Garantie gilt damit praktisch
> fürs Endergebnis. (2) Die k-Garantie erstreckt sich **nicht** auf die
> per-Option-„davon verifiziert"-Zahlen sichtbarer Optionen (ADR-014-gewollt, können < k sein).

# k-Anonymity for Segmented Results (Loop 2)

Public results may be broken down by segment (e.g. by PLZ region or scope). Segmentation must
never let anyone re-identify how a small group voted. `polls.min_k_anonymity` (default 10) is
the threshold `k`.

## The leak naive suppression misses
Hiding only segments with `count < k` is **not enough**: if the overall total is shown and only
one segment is hidden, that segment = total − (sum of visible segments). This is *complementary
disclosure*. The algorithm below closes it.

## Algorithm (apply per breakdown)
Input: total `N`, segments each with a count `cᵢ`, threshold `k`.

1. **Whole-poll guard:** if `N < k`, show **no** breakdown at all (and consider hiding the raw
   tally too, depending on poll sensitivity). Otherwise continue.
2. **Primary suppression:** mark every segment with `cᵢ < k` as suppressed.
3. **Complementary suppression:** if exactly one segment is suppressed, suppress the next
   smallest **non-suppressed** segment as well. Repeat until either zero or ≥2 segments are
   suppressed *and* the sum of suppressed counts is itself `≥ k` (so the hidden mass can't be
   pinned to one group). If everything collapses, fall back to "no breakdown".
4. **Render:** show visible segments with counts; render suppressed ones as a single merged
   "Zu wenige Teilnehmende für eine sichere Auswertung" bucket — never as `0` or blank, and
   never with a count.

## UI rule (transparency)
Always *explain* redaction, e.g.:
> „Einzelne Segmente werden ausgeblendet, um die Anonymität kleiner Gruppen zu schützen
> (mind. {k} Teilnehmende pro Segment)."

This builds trust and prevents misreading a hidden segment as "no votes".

## Notes
- Compute on the server from `votes`; never ship raw per-segment counts below `k` to the client.
- `k` is per-poll (`min_k_anonymity`, CHECK ≥ 2; default 10). Document the chosen `k` near results.
- Live results during an open poll are out of scope (see FEATURES "Out of Scope"); results are
  shown after `ended`.
