/**
 * faq-daten.ts — Häufige Fragen (eine Quelle für Landing-Sektion + /faq-Seite).
 *
 * Die Landing zeigt die FAQ nur anonymen Erstbesuchern (sie verschwindet mit dem
 * Region-Cookie); die eigenständige /faq-Seite hält die Antworten dauerhaft
 * erreichbar (Footer-Link).
 */

export const FAQ: { f: string; a: string }[] = [
  { f: "Ist das wirklich anonym?", a: "Ja. Wir speichern nicht, wie Sie abgestimmt haben. Ihre Stimme ist von Ihrer Person getrennt (geheime Wahl)." },
  { f: "Kostet das etwas?", a: "Nein. Die Teilnahme ist für Bürgerinnen und Bürger kostenlos." },
  { f: "Brauche ich eine App?", a: "Nein. Alles läuft im Browser — am Handy, Tablet oder Computer." },
  { f: "Ab welchem Alter?", a: "Ab 16 Jahren. Das bestätigen Sie einmalig bei der Anmeldung." },
  { f: "Brauche ich ein Passwort?", a: "Nein. Sie erhalten einen Anmelde-Link per E-Mail — ohne Passwort." },
  { f: "Ich bin technisch unsicher — geht das trotzdem?", a: "Ja. Sie brauchen nur Ihre Postleitzahl und eine E-Mail-Adresse. Mehr nicht." },
];
