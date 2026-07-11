# ADR-021 — Souveräne Kanalstrategie: die eigene Seite ist der Kanal

**Status:** umgesetzt (2026-07-10) · **Entscheider:** Patrick.

## Kontext

Der Digest braucht Reichweite (Henne-Ei, Konzept Kap. 4/8). Die ursprüngliche
Kanalplanung (Konzept Kap. 8, Entscheidung 9) sah **Telegram + WhatsApp** vor.
Seither ist das Kernversprechen des Produkts geschärft worden: *deutscher Server,
kurze AVV-Kette, keine US-Dienstleister, digitale Souveränität* — es ist das
zentrale B2G-Verkaufsargument (Launch-Kit `02`, Deck-Folie 8).

**Der Widerspruch:** Souveränität predigen und Ratsinformationen über einen
proprietären Messenger aus Dubai (Telegram) bzw. einen Meta-Dienst (WhatsApp)
verteilen. Im Pitch ist das ein offener Angriffspunkt; inhaltlich untergräbt es
genau die Eigenschaft, für die eine Kommune zahlen soll.

## Entscheidung

1. **Die eigene Seite ist der Kanal.** Jeder Digest hat einen Permalink
   (`/[tenant]/digest/[id]`) mit OpenGraph-Metadaten und einem **serverseitig
   erzeugten Vorschaubild** (`opengraph-image.tsx`, Next.js/Satori — kein externer
   Bilddienst, kein Canva-Export, keine CDN in der Kette). Soziale Netzwerke
   erhalten nur **Anreißer + Link**; der Inhalt lebt auf dem eigenen Server.
   RSS bleibt gleichwertiger, konto- und trackingfreier Zugang.
2. **Verbreitung nur über offene Protokolle:**
   - **Mastodon / ActivityPub** (W3C-Standard, Instanz frei wählbar, notfalls
     selbst hostbar) — **primär**.
   - **Bluesky / AT-Protocol** — sekundär: offenes Protokoll, aber US-Unternehmen;
     mitgenommen für Reichweite in Journalismus/Politik, bewusst nachrangig.
3. **Telegram und WhatsApp entfallen ersatzlos.** Code (`lib/channels/telegram.ts`),
   Tests und der WhatsApp-Copy-Button wurden entfernt; die Datenschutzerklärung
   benennt die neue Kanallage. Das ersetzt Konzept-Entscheidung 9 (Kap. 8).
4. **Das menschliche Freigabe-Gate bleibt vorgelagert und unangetastet**
   (Konzept Kap. 10). Gepostet wird ausschließlich beim Übergang
   `freigegeben → veroeffentlicht`. Kanal-Fehler sind best-effort: sie werden
   PII-frei auditiert (`digest.channel_error`), brechen die Veröffentlichung aber
   nie ab — der Digest steht ohnehin bereits auf der eigenen Seite.
5. **Keine automatische Einordnung, kein investigativer Kanal unter der Marke.**
   Die Kanäle verbreiten ausschließlich *Status* mit Quellenlink (Neutralitäts-
   kodex, Kap. 10.1). Recherche/Einordnung findet außerhalb von Partizip statt
   (privates Werkzeug, siehe Rollen-Entscheidung unten).

## Rollen-Entscheidung (Interessenkonflikt)

Partizip verkauft Kommunen Infrastruktur *und* beobachtet dieselben Kommunen.
Beides zugleich unter einer Marke zerstört entweder den Vertrieb oder die
Glaubwürdigkeit. Entschieden: **Weg C — Anbieter jetzt, Wächter später.**
Partizip bleibt neutrale Infrastruktur; investigative Recherche-Ergebnisse gehen
an Lokaljournalisten (bzw. das Werkzeug selbst wird ihnen zur Verfügung gestellt),
nicht als Einordnung unter der Partizip-Marke. Ein späterer Wechsel zu Weg B
(eigener journalistischer Kanal) bleibt möglich; der umgekehrte Weg nicht.

## Konsequenzen

- Neue env (alle optional, no-op wenn leer): `MASTODON_INSTANCE_URL`,
  `MASTODON_ACCESS_TOKEN`, `BLUESKY_IDENTIFIER`, `BLUESKY_APP_PASSWORD`,
  `BLUESKY_SERVICE`. Entfallen: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`.
- Kanal-Schicht (`lib/channels/`) ist ein sauberer Schnitt entlang „liest nur
  Veröffentlichtes" — die Voraussetzung, sie bei Traktion als eigenes Repo
  herauszulösen (Stufe 2 der Kanal-Roadmap).
- Bluesky-Handle sollte per DNS (`_atproto`-TXT) auf `partizip.online` verifiziert
  werden; Mastodon-Profil per `rel="me"`-Link. Beides = Aufgabe Patrick (DNS/Konten).
- Pitch/Launch-Kit: Kanalstrategie und „gebaut vs. Roadmap" entsprechend angepasst.
