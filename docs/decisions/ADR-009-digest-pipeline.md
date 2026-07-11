# ADR-009 — Digest-Pipeline M7 (Taunusstein in 90 Sekunden)

**Status:** Angenommen  
**Datum:** 2026-06-10  
**Autor:** Projektleitung Partizip

---

## Kontext

Bürgerinnen und Bürger haben wenig Zeit, die vollständigen Protokolle und Vorlagen aus
Ratsinformationssystemen (RIS) zu lesen. Ziel von M7 ist eine automatisierte Pipeline,
die Ratssitzungen importiert, eine kurze Zusammenfassung (Digest) erstellt und nach
menschlicher Freigabe öffentlich zugänglich macht — ohne Login, ohne Barrieren.

Zwei RIS-Systeme sind relevant:
- **Provox IIP** (Rheingau-Taunus-Kreis, RTK): HTML-Scraping via Meeting-List + Detail-Page
- **ALLRIS 4** (Taunusstein): HTML-Scraping via bekannte SILFDNRs (keine Listenseite)

---

## Entscheidungen

### 1. Shared RisAdapter-Interface

Beide RIS-Systeme implementieren dieselbe Schnittstelle (`RisAdapter`):
- `listRecentMeetings()` → `MeetingRef[]`
- `fetchMeeting(ref)` → `FetchedMeeting` (mit Dokumenten und optionalem PDF-Text)

Das erlaubt einheitliche Import-Skripte unabhängig vom RIS-Typ.

### 2. Fetch-Wrapper mit Throttling

`risGet()` erzwingt mindestens 1100 ms zwischen Requests an denselben Host.  
User-Agent: `PartizipBot/0.1 (+https://partizip.online; kontakt folgt)`.  
Timeout: 15 Sekunden. Kein Retry-Loop (Fehler werden geloggt, Import läuft weiter).

### 3. PDF-Textextraktion mit pdf-parse@1.1.1

`pdf-parse` v1 hat eine einfache Funktions-API (`pdfParse(buffer)`).  
v2 hat eine inkompatible Klassen-API — deshalb wird v1 fixiert.  
Bei Fehlern (Scan-PDFs, leere Dokumente) wird `null` zurückgegeben; der Import läuft weiter.

### 4. extractive_v1 — deterministischer Generator, kein LLM

Digests werden durch Textselektion aus Dokumenten erstellt (kein LLM-Einsatz in v1).  
Priorität: Beschlussvorlagen (docType `vorlage`) > Tagesordnungspunkte (`top`) >
Fallback auf Einladung/Tagesordnung.

`llm_v1` ist als Interface-Stub vorbereitet, aber nicht aktiv. Der Stub wirft einen
Fehler mit Eskalationshinweis, damit versehentlicher Einsatz auffällt.

### 5. Freigabe-Gate — nicht verhandelbar

**Kein Digest wird ohne menschliche Freigabe veröffentlicht.**

Statusübergänge:
```
entwurf → freigegeben (nur kommune_admin / super_admin; setzt approved_at)
freigegeben → veroeffentlicht (nur admin; setzt published_at; triggert Telegram)
```

Beide Übergänge sind als Server Actions implementiert (Gate-B-Pflicht: kein
Client-State-Bypass möglich).

**Doppelte Absicherung:**
1. Application-Layer: Status-Check vor dem UPDATE
2. DB-CHECK-Constraint (Migration 0006): verhindert inkonsistente Zustände direkt in
   der Datenbank — auch bei direkten SQL-Zugriffen

```sql
CHECK (status != 'veroeffentlicht' OR (approved_at IS NOT NULL AND published_at IS NOT NULL))
CHECK ((status != 'freigegeben' AND status != 'veroeffentlicht') OR approved_at IS NOT NULL)
```

### 6. Öffentliche Anzeige ohne Login (Stufe 0)

Veröffentlichte Digests sind unter `/:tenant/digest` und `/:tenant/digest/:id` ohne
Authentifizierung abrufbar. Das entspricht dem Konzept-Ziel "maximale Reichweite".

### 7. RSS 2.0 Feed

`/api/digest/rss` — `force-dynamic`, nur `status='veroeffentlicht'`, max. 20 Einträge.
Content-Type: `application/rss+xml`.

### 8. WhatsApp-One-Tap-Copy

Client-Komponente `WhatsAppCopyButton` nutzt `navigator.clipboard.writeText()`.
Kein Server-Roundtrip, kein Tracking. Neutralitätskodex: nur Fakten, keine Bewertungen.

### 9. Telegram-Kanal (vorbereitet, inaktiv)

`sendDigestToTelegram()` ist ein No-Op wenn `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHANNEL_ID`
fehlen. Aktivierung erfordert nur das Setzen der Env-Variablen.  
Fehler beim Telegram-Versand verhindern die Veröffentlichung **nicht**.

---

## Abgelehnte Alternativen

| Alternative | Grund |
|---|---|
| OParl-Standard-API | RTK und Taunusstein bieten keine OParl-Endpunkte an |
| LLM-Zusammenfassung in v1 | Kostenrisiko, Latenz, Neutralitätskodex schwer kontrollierbar |
| JWT-basiertes Freigabe-Gate | Gate-B-Lektion M2: Server-State ist sicherer |
| Einzel-Constraint im Application-Layer | DB-CHECK als letzte Verteidigungslinie nicht verzichtbar |

---

## Konsequenzen

- RIS-Import ist manuell / per Cron aufrufbar (`npm run ris:import`)
- ALLRIS-Sitzungen müssen manuell per SILFDNR registriert werden (`npm run ris:add-meeting`)
- Digest-Generierung ist deterministisch reproduzierbar (kein LLM-Drift)
- Freigabe-Gate schützt vor versehentlicher Veröffentlichung auf DB-Ebene
- Telegram-Kanal kann ohne Code-Änderung aktiviert werden
