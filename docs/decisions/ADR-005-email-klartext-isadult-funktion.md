# ADR-005 — users.email Klartext + isAdult als Funktion statt Spalte

**Datum:** 2026-06-10 · **Status:** Entschieden (M1) · **Bezug:** Konzept Kap. 7, ADR-003

**Entscheidung 1 — E-Mail im Klartext:** `users.email` wird ungehasht gespeichert.
Begründung: Eigen-Auth (ADR-002) sendet Magic-Links an die Adresse; dafür ist der
Klartext zwingend erforderlich. Zweckbindung: ausschließlich Auth-Flow (Konzept
Kap. 7). E-Mail darf niemals in Logs, Audit-Metadaten oder API-Responses erscheinen.

**Entscheidung 2 — `is_adult` als Funktion, nicht als Spalte:** Eine gespeicherte
`is_adult`-Spalte wäre zu einem gegebenen Zeitpunkt korrekt, aber nicht immutable
(eine Person wird mit der Zeit volljährig). Stattdessen: Helper `isAdult(birthYear,
birthMonth, now)` in `src/lib/age.ts`. Logik: volljährig erst, wenn der Monat des
18. Geburtstags vollständig abgelaufen ist (`nowYear > y+18` oder `nowYear === y+18
AND nowMonth > birthMonth`). Bei NULL: false (konservativ).
