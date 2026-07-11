# Digest erstellen mit Assisted-V1-Workflow (Patrick-Anleitung)

Dieser Workflow ermöglicht es, einen bürgerfreundlichen Digest-Entwurf für eine
Ratssitzung zu erstellen, ohne API-Kosten zu verursachen. Claude Code auf der VM
formuliert die Aussagen, ein Import-Skript validiert sie mit denselben harten Regeln
wie der vollautomatische Generator.

---

## Der Wochenlauf — Patricks Standard-Anwendungsfall (geklärt 2026-06-11)

Du musst **keine Meeting-IDs kennen und keinen Befehl tippen.** Der gedachte
Rhythmus ist: einmal pro Woche (oder wann immer du willst) sagst du Claude
Code einen Satz wie:

> „Guck mal, was neues passiert ist, und mach die Digests."

Claude Code erledigt dann den kompletten Stapel:

1. `npm run ris:import` für alle aktiven Gremien — holt alles, was seit dem
   letzten Lauf neu im Ratsinformationssystem ist (der Import ist
   idempotent; was schon da ist, wird nicht doppelt angelegt).
2. Ermittelt alle Sitzungen mit Dokumenten, die **noch keinen Digest**
   haben (egal ob die letzte Auswertung am 01.06. war und heute der 11.06.
   ist — es zählt „hat schon einen Digest oder nicht", nicht das Datum).
3. Für jede dieser Sitzungen: Export → bürgerfreundlich formulieren →
   Import als Entwurf (Schritte 2–4 unten), **eine Sitzung = ein Digest**
   (nicht ein Digest pro Vorlage/Vorschlag — die einzelnen Vorlagen werden
   Aussagen innerhalb des Sitzungs-Digests).
4. Meldet dir am Ende die Liste der angelegten Entwürfe mit Admin-Links.

Deine To-do-Liste ist danach die **Digest-Übersicht im Admin-UI**: Alles
mit Status „Entwurf" wartet auf dein Abnicken (Quelllinks prüfen →
freigeben → veröffentlichen). Bereits freigegebene oder veröffentlichte
Digests fasst der Lauf nie an.

Die folgenden Abschnitte beschreiben, was dabei im Einzelnen passiert —
relevant für dich ist davon nur Schritt 5 (Freigabe).

---

## Voraussetzung

- Du bist auf der VM eingeloggt und Claude Code läuft (oder du startest es).
- Die Sitzung ist bereits importiert (`npm run ris:import`).
- Du kennst die Meeting-UUID (zu finden in der Admin-UI oder DB).

---

## Schritt-für-Schritt

### 1. Claude Code ansprechen

Sage Claude Code (in der VM-Sitzung):

> "Mach den Digest für die Kreistagssitzung vom 12.05. — Meeting-ID ist `<uuid>`."

Claude Code führt dann automatisch die folgenden Schritte aus:

---

### 2. Export: Dokumente als Bundle laden

Claude Code führt intern aus:

```bash
cd /home/claude/projects/partizip-wt/main/app
npm run digest:export -- --meeting <meeting-uuid>
```

Das Skript schreibt ein JSON-Bundle nach `var/digest-export/<meeting-id>.json`
und gibt den Pfad auf stdout aus. Das Bundle enthält:

- Sitzungsmetadaten (Gremium, Datum, Ort)
- Alle Dokumente mit vollständigem Textinhalt (`bodyText`)
- Eine `anleitung` mit dem exakten Ziel-JSON-Format und den Neutralitätsregeln

---

### 3. Formulieren: Claude Code erstellt die Aussagen

Claude Code liest das Bundle, liest die Dokumenttexte und formuliert bürgerfreundliche
Aussagen nach dem Neutralitätskodex:

- Nur Tatsachen aus den Dokumenten
- Kein Vorwurf, nur Status
- Kurze, verständliche Sätze ohne Verwaltungsdeutsch
- Jede Aussage mit `sourceDocumentId` aus der Dokumentliste

Das Ergebnis ist ein JSON-Objekt:

```json
{
  "title": "Kreistag – Sitzung vom 12.05.2026",
  "statements": [
    {
      "text": "Der Kreistag hat die Haushaltssatzung 2026 mit 28 Ja-Stimmen beschlossen.",
      "sourceDocumentId": "<exakte-id-aus-dem-bundle>"
    },
    {
      "text": "Das öffentliche Protokoll der Sitzung ist verfügbar.",
      "sourceDocumentId": "<protokoll-id>"
    }
  ]
}
```

Claude Code schreibt dieses JSON in eine Datei, z. B. `var/digest-export/<meeting-id>-entwurf.json`.

---

### 4. Import: Entwurf validieren und anlegen

Claude Code führt intern aus:

```bash
npm run digest:import-draft -- --meeting <meeting-uuid> --file var/digest-export/<meeting-id>-entwurf.json
```

Das Skript:
- Lädt alle Dokumente der Sitzung aus der DB
- Validiert das JSON gegen dieselben harten Regeln wie der vollautomatische Generator:
  - `title` maximal 160 Zeichen, nicht leer
  - 1 bis 30 Aussagen
  - Jede Aussage maximal 500 Zeichen
  - `sourceDocumentId` muss zu dieser Sitzung gehören
- Leitet `sourceUrl` serverseitig ab (nie aus dem JSON)
- Legt den Digest-Entwurf in der Datenbank an (`generator = "assisted_v1"`, `status = "entwurf"`)

Bei Erfolg gibt das Skript die Digest-ID aus:

```
✓ Digest angelegt (ID: abc123...)
Titel: Kreistag – Sitzung vom 12.05.2026
Aussagen: 8
Generator: assisted_v1
Status: entwurf → Freigabe via Admin-UI erforderlich.

Admin-UI: /admin/digests/abc123...
```

---

### 5. Freigabe im Admin-UI

Öffne die Admin-UI und navigiere zu:

```
https://<deine-domain>/<tenant>/admin/digests/<digest-id>
```

Dort siehst du:
- Alle Aussagen mit ihren Quelllinks
- Einen gelben KI-Hinweiskasten: „Vor der Freigabe den Quellenbezug JEDER Aussage gegen das verlinkte Dokument prüfen."
- Den Freigabe-Button (entwurf → freigegeben)

**Pflicht:** Jeden Quelllink öffnen und prüfen, ob die Aussage im Dokument belegt ist.
Erst dann freigeben. Anschließend kann veröffentlicht werden.

---

## Fehlerbehandlung

**„Digest-Entwurf existiert bereits"**
Ein Entwurf für diese Sitzung ist schon vorhanden. Entweder im Admin-UI löschen
oder die bestehende Version bearbeiten.

**„hat Status freigegeben/veroeffentlicht"**
Der Digest wurde bereits freigegeben. Freigegebene Digests werden nie automatisch
überschrieben — das ist ein Sicherheitsmerkmal.

**„ist keine gültige Dokument-ID"**
Die von Claude formulierte `sourceDocumentId` passt nicht zu den Dokumenten dieser
Sitzung. Claude Code korrigiert das manuell oder startet neu.

---

## Zwei npm-Kommandos auf einen Blick

```bash
# 1. Dokumente exportieren (Pfad wird ausgegeben)
npm run digest:export -- --meeting <meeting-uuid>

# 2. Entwurf importieren und anlegen
npm run digest:import-draft -- --meeting <meeting-uuid> --file <pfad-zum-json>
```

Beispiel mit einer echten Meeting-UUID:

```bash
npm run digest:export -- --meeting 550e8400-e29b-41d4-a716-446655440000
# → /home/claude/projects/partizip-wt/main/app/var/digest-export/550e8400-e29b-41d4-a716-446655440000.json

npm run digest:import-draft -- \
  --meeting 550e8400-e29b-41d4-a716-446655440000 \
  --file /home/claude/projects/partizip-wt/main/app/var/digest-export/550e8400-e29b-41d4-a716-446655440000-entwurf.json
```
