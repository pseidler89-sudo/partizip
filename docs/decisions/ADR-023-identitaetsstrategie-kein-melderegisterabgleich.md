# ADR-023: Identitätsstrategie — kein BundID-/Melderegisterabgleich

- **Status:** Akzeptiert (Owner-Entscheidung 2026-07-13)
- **Kontext-Quelle:** Marktanalyse zu Beteiligungsplattformen und Verifizierungs-Bausteinen (2026-07)
- **Betrifft:** [ADR-014](ADR-014-abstimm-verifikationsmodell.md) (Stufenmodell), [ADR-018](ADR-018-eid-eudi-verifizierung.md) (eID/EUDI als Provider)

## Kontext

Für die Wohnsitz-Verifizierung (Stufe 2) gibt es im deutschen Umfeld mehrere Wege. Andere
kommunale Beteiligungsplattformen setzen zunehmend auf **BundID in Verbindung mit einem
Melderegisterabgleich**: Die Bürgerin meldet sich mit dem Bundeskonto an, die Kommune gleicht
die übermittelten Daten mit dem Einwohnermelderegister ab und schaltet daraufhin frei.

Partizip verifiziert heute vor Ort — per QR-Code oder Termin (siehe ADR-014) —, mit einem
Ablauf von 24 Monaten. Die Frage war, ob wir den Melderegister-Weg ergänzen.

## Entscheidung

**Wir bauen keinen BundID-/Melderegisterabgleich.** Gründe:

1. **Reibung an der falschen Stelle.** Das Produktversprechen ist die niedrigschwellige
   Mitmach-Schleife: mitmachen kostet ein E-Mail-Konto (Stufe 1), nicht ein Behördenkonto.
   Ein vorgeschalteter Bundeskonto-Login verlagert die Hürde genau dorthin, wo wir sie
   abbauen wollen.
2. **Rechtlich unklar für private Betreiber.** Der Melderegisterabgleich ist ein Verfahren
   der Kommune. Für einen privaten Plattformbetreiber ist die Rechtsgrundlage für regelmäßige
   Abgleiche nicht geklärt; die Klärung wäre pro Kommune neu zu führen und würde uns in eine
   Rolle drängen (Datenverarbeiter über Melderegisterdaten), die wir bewusst nicht wollen.
3. **Datensparsamkeit.** Unser Verifizierungs-Ergebnis ist bewusst minimal: ein Ja/Nein zum
   Wohnsitz im Scope plus ein Ablaufdatum. Ein Registerabgleich brächte mehr personenbezogene
   Daten in unsere Systeme, als das Produkt braucht.

**eID und EUDI-Wallet bleiben Roadmap-Option** gemäß ADR-018 — als *Provider hinter einem
Verifizierungs-Interface*, niemals als Login (ADR-017/019). Bis dahin wird nichts gebaut:
Kein Adapter, keine Vorbereitung, kein Zertifikatsprozess. Wenn EUDI-Wallets in der Fläche
ankommen, wird diese Entscheidung neu bewertet.

## Konsequenzen

- Die Verifizierung vor Ort (QR/Termin) bleibt der einzige Weg zu Stufe 2. Sie ist offline,
  erklärbar und braucht keine dritte Partei — das bleibt ein bewusster Teil des Angebots.
- Kommunen, die einen Registerabgleich wünschen, können ihn als **eigenes Verfahren** betreiben
  und das Ergebnis über die vorhandene Verifizierungs-Rolle in Partizip eintragen lassen. Die
  Plattform verarbeitet dabei keine Registerdaten.
- Die in ADR-018 skizzierte Provider-Abstraktion bleibt als Ticket bestehen; sie wäre die
  Anschlussstelle, falls eID/EUDI je gebaut wird.
- Diese Entscheidung ist umkehrbar: Sie beschreibt den Stand des Pilotbetriebs, nicht ein
  Dogma. Was sie ausschließt, ist der Umweg über Register und Behördenkonto als *Standardweg*
  der Bürgerverifizierung.
