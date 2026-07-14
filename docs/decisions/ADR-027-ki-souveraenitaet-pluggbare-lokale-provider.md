# ADR-027 — KI-Souveränität: pluggbare und lokale LLM-Provider

**Status:** Akzeptiert · **Datum:** 2026-07-14 · **Entscheidung:** Owner (Patrick)
**Bezug:** Erweitert und verweist ADR-011 (KI ist optional); baut auf der
Digest-Pipeline (ADR-009), der Vier-Augen-Freigabe (ADR-012) und der
souveränen Kanalstrategie (ADR-021) auf.

## Kontext

ADR-011 hat KI als **optional und umschaltbar** festgelegt: kein Feature setzt KI
voraus, `DIGEST_GENERATOR` wählt zwischen deterministisch (`extractive_v1`),
assistiert (`assisted_v1`) und API (`llm_v2`). Offen blieb die Frage der
**Datensouveränität**: Kommunen und Datenschützer fragen zu Recht, wohin
Ratsdokumente zur Aufbereitung fließen. Eine Bindung an genau einen
Cloud-Anbieter ist für öffentliche Träger ein Hindernis; manche verlangen
Verarbeitung **on-premise**.

## Entscheidung

1. **Ratsinfo-Aufbereitung bleibt optional und umschaltbar** (bekräftigt ADR-011):
   Der deterministische Weg ist immer ein vollwertiger Standard; KI ist Komfort,
   nie Voraussetzung.
2. **Generator-Adapter machen den Provider pluggbar.** Die
   Aufbereitung spricht gegen eine **Adapter-Schnittstelle**, hinter der drei
   Provider-Klassen austauschbar sind:
   - **assistiert** (heute, `assisted_v1`): Claude Code auf der VM, menschlich
     geführt, keine API-Token-Kosten;
   - **API** (`llm_v2`): gehosteter LLM-Anbieter per Schlüssel;
   - **lokal / on-premise** (`llm_local`): ein selbst betriebenes LLM
     (z. B. auf kommunaler oder eigener Infrastruktur) für volle
     **Datensouveränität** — Dokumente verlassen die eigene Umgebung nicht.
   Die Auswahl ist **Konfiguration** (Umgebungsvariable), kein Code-Eingriff.
3. **Der Vertrauenskern ist modell-unabhängig.** Unabhängig vom Provider gilt
   unverändert: **jede Aussage ist quellen-validiert** (Mapping auf ein
   übergebenes Ratsdokument, server-seitig abgeleitete URLs, gemeinsames
   `validate-draft`-Modul) **und menschlich freigegeben** (Vier-Augen-Gate,
   ADR-012, als hartes DB-Constraint). Kein Modell entscheidet, keins
   veröffentlicht ohne Freigabe.
4. **Kommune = Konfiguration, nicht Code.** Der RIS-/Ratsinfosystem-Adapter ist
   **config-getrieben**: eine neue Kommune mit anderem RIS wird durch
   Konfiguration angebunden, nicht durch neuen Code. Ebenso ist die Wahl des
   LLM-Providers pro Betrieb konfigurierbar.

## Begründung

- **Souveränität als Verkaufsargument:** Ein lokal/on-premise betreibbares Modell
  nimmt öffentlichen Trägern das stärkste KI-Gegenargument (Datenabfluss) und ist
  EU-KI-VO-freundlich, weil keine automatisierten Entscheidungen getroffen
  werden.
- **Provider-Unabhängigkeit senkt Risiko:** Kein Lock-in an einen Anbieter;
  Preis-, Verfügbarkeits- oder Rechtsänderungen eines Anbieters bedrohen die
  Plattform nicht.
- **Vertrauen kommt aus dem Verfahren, nicht aus dem Modell:** Weil
  Quellenvalidierung und menschliche Freigabe modell-unabhängig greifen, ist die
  Wahl des LLM eine reine Betriebs-/Souveränitätsentscheidung ohne
  Vertrauensrisiko.

## Konsequenzen

- **Bauen:** Provider-Adapter-Schnittstelle mit den drei Klassen (assistiert /
  API / lokal); Konfiguration über Umgebungsvariablen analog `DIGEST_GENERATOR`;
  Laufzeit-Fallback auf `extractive_v1` bei Ausfall (wie ADR-011).
- **Unverändert:** `validate-draft`-Modul und Vier-Augen-Freigabe gelten für
  **alle** Provider identisch; der lokale Provider erhält keine Ausnahme.
- **Datenschutz:** An jeden LLM-Provider gehen ausschließlich Texte öffentlicher
  Ratsdokumente — nie Nutzerdaten, Anliegen oder E-Mail-Adressen (ADR-011). Beim
  lokalen Provider verlassen selbst diese die eigene Umgebung nicht.
- **RIS-Anbindung:** Adapter bleibt config-getrieben; neue Kommune = Konfiguration.
- Nichts in Stein — bewährt sich etwas nicht, wird es geändert.
