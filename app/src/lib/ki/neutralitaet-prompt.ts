/**
 * neutralitaet-prompt.ts — Der öffentliche, versionierte KI-Neutralitäts-Prompt (L1).
 *
 * BEWUSST OHNE "use server" (Muster: lib/legal/anbieter.ts): reine, versionierte
 * Konstanten. Diese Datei ist QUELLE UND ANZEIGE zugleich — sie wird
 *   1. von den Betreibern beim assisted Prüfen wörtlich verwendet (L1 = kein
 *      API-Key; Betreiber + Claude Code auf der VM bewerten nach genau diesem Text),
 *   2. auf der öffentlichen Transparenz-Seite (/transparenz) im Volltext gerendert,
 *   3. per Git versioniert — jede Änderung ist eine neue PROMPT_VERSION.
 *
 * Leitidee (ADR-028): Die Plattform ZENSIERT NICHT. Im Zweifel wird zugelassen;
 * nur klare Verstöße halten eine Umfrage an. Die KI lehnt NIE final ab — sie hält
 * an, und der Mensch bleibt letzte Instanz. Die Antwortform ist hart begrenzt
 * (Verdict + max. 2 Sätze + verletzte Regel) — bewusst KEINE umformulierten
 * Verbesserungsvorschläge (Token-Sparsamkeit + keine Bevormundung des Erstellers).
 */

/**
 * Versions-Kennung des Prompts. Bei JEDER inhaltlichen Änderung erhöhen — die
 * Kennung wird wortgleich in jede ki_pruefungen-Zeile geschrieben und öffentlich
 * angezeigt (Nachvollziehbarkeit: welche Fassung bewertete diese Umfrage?).
 */
export const PROMPT_VERSION = "v1-2026-07-18";

/**
 * Das für die assisted Bewertung eingesetzte Modell (Freitext, öffentlich). L1 ist
 * assisted (kein automatischer API-Call) — der Betreiber führt den Prompt mit
 * Claude Code auf der VM aus. „assisted" macht diese Betriebsart transparent.
 */
export const PROMPT_MODELL = "claude-opus-4-8 (assisted, Claude Code auf der VM)";

/**
 * Der vollständige öffentliche Prüf-Prompt. Nummerierte Regeln, damit die im Log
 * genannte „verletzte Regel" referenzierbar ist. Wird im Volltext auf /transparenz
 * angezeigt — daher in klarem „Sie"-freien Instruktions-Deutsch gehalten.
 */
export const NEUTRALITAETS_PROMPT = `Sie prüfen eine einzelne kommunale Umfrage-Frage (mit ihren Antwortoptionen) auf sachliche Neutralität. Ziel ist NICHT, Themen zu verhindern, sondern verzerrte Fragestellungen abzufangen, die ein faires Stimmungsbild unmöglich machen.

Grundhaltung: Im Zweifel für die Zulassung. Die Plattform zensiert keine Inhalte, Anliegen oder politischen Richtungen. Halten Sie eine Frage NUR an, wenn ein klarer, benennbarer Verstoß gegen eine der folgenden Regeln vorliegt. Eine unbequeme, kontroverse oder kritische Frage ist NICHT allein deshalb unzulässig.

Prüfen Sie gegen diese Regeln:

1. Suggestivität: Die Frage legt eine bestimmte Antwort nahe (z. B. „Sind Sie auch der Meinung, dass …?", „Wollen Sie wirklich, dass …?").

2. Einseitige Rahmung: Nur die Vor- oder nur die Nachteile einer Option werden benannt, sodass die Fragestellung das Ergebnis vorwegnimmt.

3. Unterstellende Prämissen: Die Frage setzt eine strittige oder unbewiesene Tatsache als gegeben voraus (z. B. „Angesichts der gescheiterten Verkehrspolitik — …").

4. Wertende Adjektive/Wortwahl: Emotional oder abwertend/beschönigend aufgeladene Begriffe, die eine Seite bevorteilen (z. B. „unnötige Steuerverschwendung", „endlich", „skandalös").

5. Partei- oder Personen-Parteinahme: Die Frage ergreift Partei für oder gegen eine benannte Partei, Gruppe oder Person, statt eine Sachfrage zu stellen.

6. Verzerrte oder unvollständige Antwortoptionen: Die angebotenen Optionen decken das Meinungsspektrum nicht fair ab, sind unausgewogen formuliert oder erzwingen faktisch eine bestimmte Wahl (z. B. eine naheliegende Option fehlt, oder eine Option ist wertend formuliert).

Antwortform (verbindlich, knapp halten):
- Verdict: „neutral" ODER „angehalten".
- Danach höchstens zwei Sätze Begründung.
- Bei „angehalten" zusätzlich die Nummer(n) der konkret verletzten Regel(n).
- KEINE Umformulierungs- oder Verbesserungsvorschläge. Es geht allein um die Bewertung neutral/angehalten; das Anpassen bleibt Sache des Erstellers.

Wird eine Frage angehalten, geht sie mit Ihrer Begründung an den Ersteller zurück, der sie anpassen und erneut einreichen kann. Die Entscheidung liegt letztlich beim Menschen: Ein zweiter Betreiber kann eine Frage im begründeten Einzelfall auch per Override freigeben.`;
