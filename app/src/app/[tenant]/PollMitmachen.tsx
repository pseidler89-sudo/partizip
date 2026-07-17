/**
 * PollMitmachen.tsx — Client-Flow für die Mitmach-Schleife (M3, ADR-014).
 *
 * Zustände:
 *   - nicht eingeloggt: Frage + ERGEBNIS sichtbar (Wert vor der Anmeldung) +
 *     freundlicher CTA „Zum Mitstimmen anmelden" (kein aktiver Abstimm-Button).
 *   - "frage":    Abstimm-Buttons (ja/nein/enthaltung) → Server-Action abstimmen()
 *   - "ergebnis": Bei BEENDETER Umfrage Balken je Option, Gesamtzahl + "davon Y
 *                 verifiziert" (dezent, mit kurzer Erklärung); bei LAUFENDER
 *                 Umfrage (ADR-022, ergebnis.aufschluesselungNachSchluss) statt
 *                 Balken ein positiver "Ausgezählt wird nach Abstimmungsende"-
 *                 Hinweis mit Gesamt + Verifiziert. Hinweis (un)verbindlich,
 *                 Folge-CTAs.
 *
 * Mitstimmen erfordert ein Konto (Stufe 1). Frage UND Ergebnis bleiben für alle
 * sichtbar — nur das Mitstimmen kostet die kurze Anmeldung. Falls die Action
 * dennoch needLogin meldet (z. B. abgelaufene Session), wird der Anmelde-CTA
 * gezeigt statt eines Fehlers.
 *
 * Nach erfolgreicher Stimme (oder "bereits abgestimmt") wird direkt das Ergebnis
 * gezeigt — ohne harten Reload. router.refresh() holt die frischen Zahlen aus der
 * Server-Komponente nach. Die getroffene Wahl wird NICHT an den Client zurück-
 * gegeben (Secret Ballot) — wir zeigen nur die Aggregation.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { abstimmen } from "@/lib/polls/actions";
import { demoSessionStarten } from "@/lib/demo/actions";
import { K_ANONYMITY_SCHWELLE, type PollErgebnis } from "@/lib/polls/ergebnis";
import { OPEN_LOGIN_EVENT } from "./LoginEntry";
import StufenFortschritt from "./StufenFortschritt";
import { Check, X, Minus, Lock, BadgeCheck, EyeOff, Bookmark, Copy, HelpCircle, ChevronDown, Hourglass } from "lucide-react";

type Choice = "ja" | "nein" | "enthaltung";

const CHOICE_LABELS: Record<Choice, string> = {
  ja: "Ja",
  nein: "Nein",
  enthaltung: "Enthaltung",
};

// Design-System: Ja=Haken, Nein=Kreuz, Enthaltung=Minus (Lucide, neutral gleichwertig).
const CHOICE_ICONS = { ja: Check, nein: X, enthaltung: Minus } as const;

interface Props {
  pollId: string;
  verbindlich: boolean;
  tenantSlug: string;
  /** Ist der Besucher eingeloggt (Stufe ≥ 1)? Mitstimmen nur dann. */
  eingeloggt: boolean;
  /** Ist der Wohnsitz verifiziert (Stufe ≥ 2)? Nötig für verbindliche Abstimmungen. */
  verifiziert: boolean;
  /** Hat der Besucher bereits abgestimmt (server-seitig ermittelt)? */
  bereitsAbgestimmt: boolean;
  /** Aktuelle Aggregation (immer übergeben, damit das Ergebnis sofort steht). */
  ergebnis: PollErgebnis;
  /**
   * Demo-Mandant (Akquise-Spielwiese): Abstimmen erzeugt bei Bedarf eine
   * ephemere Demo-Session statt des Anmelde-CTAs. Serverseitig erzwingt
   * demoSessionStarten() das Demo-Gate erneut — das Prop steuert nur die UI.
   */
  demoMode?: boolean;
}

/**
 * Dezente Zeile „X Stimmen, davon Y wohnsitz-verifiziert" + Kleintext-Erklärung.
 * Auch für nicht angemeldete sichtbar — macht Verifizierung erstrebenswert, ohne
 * die normalen Stimmen abzuwerten (kein Alarm-Ton).
 */
export function VerifiziertHinweis({ ergebnis }: { ergebnis: PollErgebnis }) {
  return (
    <>
      <p className="mt-4 text-sm" style={{ color: "var(--pz-body)" }}>
        <strong>{ergebnis.gesamt}</strong>{" "}
        {ergebnis.gesamt === 1 ? "Stimme" : "Stimmen"}, davon{" "}
        <strong>{ergebnis.verifiziert}</strong> wohnsitz-verifiziert.
      </p>
      <p className="mt-1 text-xs" style={{ color: "var(--pz-muted)" }}>
        Verifizierte Stimmen stammen von wohnsitz-bestätigten Bürger:innen.
      </p>
    </>
  );
}

/**
 * ADR-022: Laufende Umfrage — die per-Option-Aufschlüsselung kommt erst nach
 * Abstimmungsende (serverseitig sind alle Options-Zahlen null). Statt Balken
 * ein positiver Hinweis mit den beiden Poll-Ebene-Signalen (ADR-014).
 */
function AuszaehlungNachSchluss({
  ergebnis,
  verbindlich,
}: {
  ergebnis: PollErgebnis;
  verbindlich: boolean;
}) {
  return (
    <div>
      <div
        className="flex items-start gap-2.5 rounded-md border border-[color:var(--pz-line)] px-3 py-3"
        style={{ backgroundColor: "var(--pz-page)" }}
      >
        <Hourglass
          aria-hidden
          className="mt-0.5 h-4 w-4 shrink-0"
          style={{ color: "var(--pz-brand-strong)" }}
          strokeWidth={2}
        />
        <span className="text-sm" style={{ color: "var(--pz-body)" }}>
          <b style={{ color: "var(--pz-ink)" }}>
            Ausgezählt wird nach Abstimmungsende.
          </b>{" "}
          {ergebnis.gesamt === 0 ? (
            "Machen Sie den Anfang — Ihre Stimme zählt."
          ) : (
            <>
              Bisher <strong>{ergebnis.gesamt}</strong>{" "}
              {ergebnis.gesamt === 1 ? "Stimme" : "Stimmen"}, davon{" "}
              <strong>{ergebnis.verifiziert}</strong> wohnsitz-verifiziert.
            </>
          )}
        </span>
      </div>
      <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
        Wie bei einer Wahl veröffentlichen wir das Ergebnis je Antwort als einen
        finalen Stand nach dem Ende der Abstimmung — so bleibt jede Stimme
        unbeeinflusst von Zwischenständen.
      </p>
      <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
        {verbindlich
          ? "Verbindliche Abstimmung — gewertet werden wohnsitz-verifizierte Stimmen."
          : "Unverbindliches Stimmungsbild."}
      </p>
    </div>
  );
}

function Ergebnisanzeige({
  ergebnis,
  verbindlich,
}: {
  ergebnis: PollErgebnis;
  verbindlich: boolean;
}) {
  // ADR-022: laufende Umfrage → kein Balken/Prozent, nur der positive Hinweis.
  if (ergebnis.aufschluesselungNachSchluss) {
    return <AuszaehlungNachSchluss ergebnis={ergebnis} verbindlich={verbindlich} />;
  }

  const choices: Choice[] = ["ja", "nein", "enthaltung"];
  return (
    <div>
      <ul className="space-y-3">
        {choices.map((c) => {
          const opt = ergebnis.optionen.find((o) => o.choice === c);
          const prozent = opt?.prozent ?? 0;
          const count = opt?.count ?? 0;
          const verif = opt?.verifiziert ?? 0;
          const unverif = Math.max(0, count - verif);
          return (
            <li key={c}>
              {opt?.maskiert ? (
                // k-Anonymität (M6): kleine Gruppen (1..k-1) nicht mit Einzelzahl zeigen.
                <div
                  className="flex items-center gap-2.5 rounded-md border border-[color:var(--pz-line)] px-3 py-2.5"
                  style={{ backgroundColor: "var(--pz-page)" }}
                >
                  <EyeOff aria-hidden className="h-4 w-4 shrink-0" style={{ color: "var(--pz-muted)" }} strokeWidth={2} />
                  <span className="text-xs" style={{ color: "var(--pz-muted)" }}>
                    <b style={{ color: "var(--pz-body)" }}>{CHOICE_LABELS[c]} — ausgeblendet.</b>{" "}
                    Gruppen mit weniger als {K_ANONYMITY_SCHWELLE} Stimmen zeigen wir nicht — und
                    damit sich nichts zurückrechnen lässt, ggf. eine weitere Option.
                  </span>
                </div>
              ) : (
                <>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium" style={{ color: "var(--pz-ink)" }}>
                      {CHOICE_LABELS[c]}
                    </span>
                    <span style={{ color: "var(--pz-muted)" }}>
                      {prozent}% · {count} {count === 1 ? "Stimme" : "Stimmen"}
                      {count > 0 && <> · {verif} verifiziert</>}
                    </span>
                  </div>
                  {/* Balken: gefüllter Anteil = prozent%, darin zwei Segmente —
                      wohnsitz-verifiziert (kräftig) + nicht verifiziert (heller, gleicher
                      Markenton). Macht den Verifizierungs-Anteil direkt ablesbar. */}
                  <div
                    className="mt-1 flex h-2.5 w-full overflow-hidden rounded-full"
                    style={{ backgroundColor: "var(--pz-line)" }}
                    role="meter"
                    aria-valuenow={prozent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${CHOICE_LABELS[c]}: ${prozent} Prozent (${count} Stimmen, davon ${verif} wohnsitz-verifiziert)`}
                  >
                    <div className="flex h-full transition-all" style={{ width: `${prozent}%` }}>
                      <div
                        className="h-full"
                        style={{ flexGrow: verif, backgroundColor: "var(--tenant-primary)" }}
                      />
                      <div
                        className="h-full"
                        style={{ flexGrow: unverif, backgroundColor: "var(--tenant-primary)", opacity: 0.4 }}
                      />
                    </div>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {/* Legende für die zwei Balken-Segmente */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs" style={{ color: "var(--pz-muted)" }}>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: "var(--tenant-primary)" }} aria-hidden />
          wohnsitz-verifiziert
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: "var(--tenant-primary)", opacity: 0.4 }} aria-hidden />
          nicht verifiziert
        </span>
      </div>

      <VerifiziertHinweis ergebnis={ergebnis} />

      <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
        {verbindlich
          ? "Verbindliche Abstimmung — gewertet werden wohnsitz-verifizierte Stimmen."
          : "Unverbindliches Stimmungsbild."}
      </p>
    </div>
  );
}

/**
 * BelegCard — einmalige Anzeige des Beleg-Codes nach einer frischen Stimme (D4,
 * ADR-016). Einklappbar („Beleg speichern") + verschachteltes „Wie funktioniert
 * das?". Der Code beweist DASS, nie WIE — und wird nie pro Person gespeichert,
 * lässt sich also nach dem Verlassen der Seite nicht erneut abrufen.
 */
function BelegCard({ code }: { code: string }) {
  const [kopiert, setKopiert] = useState(false);

  async function kopieren() {
    try {
      await navigator.clipboard.writeText(code);
      setKopiert(true);
      window.setTimeout(() => setKopiert(false), 2000);
    } catch {
      // Clipboard nicht verfügbar (z. B. ohne HTTPS) — Code bleibt sichtbar/markierbar.
    }
  }

  return (
    <details
      className="mb-5 overflow-hidden rounded-xl border"
      style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-surface)" }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden" style={{ color: "var(--pz-ink)" }}>
        <Bookmark aria-hidden className="h-[17px] w-[17px] shrink-0" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
        Beleg speichern
        <ChevronDown aria-hidden className="ml-auto h-4 w-4 shrink-0" style={{ color: "var(--pz-muted)" }} strokeWidth={2} />
      </summary>
      <div className="flex flex-col gap-3 px-3.5 pb-3.5">
        <p className="text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
          Nach Ende der Abstimmung können Sie mit diesem Code selbst nachsehen, dass
          Ihre Stimme mitgezählt wurde — er verrät{" "}
          <b style={{ color: "var(--pz-ink)" }}>nicht</b>, wie Sie gestimmt haben.
          Bewahren Sie ihn auf: Aus Datenschutzgründen können wir ihn Ihnen später
          nicht erneut zeigen.
        </p>
        <div
          className="flex items-center justify-between gap-2.5 rounded-md border border-dashed px-3 py-2.5"
          style={{ borderColor: "var(--pz-line-strong, var(--pz-line))", backgroundColor: "var(--pz-page)" }}
        >
          <span className="font-mono text-base font-medium tracking-wide" style={{ color: "var(--pz-ink)" }}>
            {code}
          </span>
          <button
            type="button"
            onClick={kopieren}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-1"
            style={{ borderColor: "var(--pz-line)", backgroundColor: "var(--pz-surface)", color: "var(--pz-body)" }}
            aria-live="polite"
          >
            <Copy aria-hidden className="h-[13px] w-[13px]" strokeWidth={2} />
            {kopiert ? "Kopiert" : "Kopieren"}
          </button>
        </div>
        <details className="border-t pt-3" style={{ borderColor: "var(--pz-line)" }}>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-sm font-semibold [&::-webkit-details-marker]:hidden" style={{ color: "var(--pz-brand-strong)" }}>
            <HelpCircle aria-hidden className="h-[15px] w-[15px] shrink-0" strokeWidth={2} />
            Wie funktioniert das?
          </summary>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--pz-body)" }}>
            Nach Ende der Abstimmung veröffentlichen wir eine anonyme Liste aller
            Belege. Finden Sie Ihren Code darin, ist Ihre Stimme nachweislich im
            Ergebnis enthalten — ohne dass die Liste verrät, wer wie abgestimmt hat.
          </p>
        </details>
      </div>
    </details>
  );
}

/** CTA für nicht angemeldete: Ergebnis sichtbar, Mitstimmen erfordert Anmeldung. */
function AnmeldeCta({ tenantSlug }: { tenantSlug: string }) {
  return (
    <div className="mt-5 border-t border-[color:var(--pz-line)] pt-5 text-center">
      <p className="text-sm font-medium" style={{ color: "var(--pz-ink)" }}>
        Möchten Sie mitstimmen?
      </p>
      <p className="mx-auto mt-1 max-w-sm text-xs" style={{ color: "var(--pz-muted)" }}>
        Mitstimmen geht nur mit Konto (E-Mail-Link, ohne Passwort) — so hängt jede
        Stimme an einer bestätigten Person. Das Ergebnis wird nach Abstimmungsende
        für alle sichtbar — ganz ohne Anmeldung.
      </p>
      <Link
        href={`/${tenantSlug}/anmelden`}
        onClick={(e) => {
          // Progressive Enhancement: Modal öffnen statt Seitenwechsel; ohne JS
          // navigiert der Link normal zur /anmelden-Seite.
          e.preventDefault();
          window.dispatchEvent(new Event(OPEN_LOGIN_EVENT));
        }}
        className="pz-btn pz-btn-primary mt-3"
      >
        Zum Mitstimmen anmelden
      </Link>
    </div>
  );
}

export default function PollMitmachen({
  pollId,
  verbindlich,
  tenantSlug,
  eingeloggt,
  verifiziert,
  bereitsAbgestimmt,
  ergebnis,
  demoMode = false,
}: Props) {
  const router = useRouter();
  // Nicht eingeloggt: immer Ergebnis + Anmelde-CTA. Eingeloggt: Frage oder Ergebnis.
  const [phase, setPhase] = useState<"frage" | "ergebnis">(
    bereitsAbgestimmt ? "ergebnis" : "frage"
  );
  const [submitting, setSubmitting] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  // In dieser Sitzung gerade abgestimmt → Bestätigungs-Banner im Ergebnis zeigen.
  const [justVoted, setJustVoted] = useState(false);
  // Einmaliger Beleg-Code (nur bei frischer Stimme; nie nachladbar, D4/ADR-016).
  const [beleg, setBeleg] = useState<string | null>(null);

  async function handleVote(choice: Choice) {
    setError(null);
    setSubmitting(choice);
    try {
      // Demo-Spielwiese: ohne Session zuerst ein ephemeres Demo-Konto anlegen
      // (serverseitig NUR auf dem Demo-Mandanten möglich, gedeckelt). Danach
      // läuft die Stimme über den normalen, unveränderten abstimmen()-Pfad.
      if (demoMode && (!eingeloggt || needLogin)) {
        const demo = await demoSessionStarten();
        if (!demo.ok) {
          setError(demo.error ?? "Demo-Start fehlgeschlagen.");
          return;
        }
        setNeedLogin(false);
      }
      const result = await abstimmen(pollId, choice);
      if (!result.ok) {
        // needLogin: freundlicher CTA statt Fehler (z. B. Session abgelaufen).
        if (result.needLogin) {
          setNeedLogin(true);
          return;
        }
        setError(result.error ?? "Abstimmen fehlgeschlagen.");
        return;
      }
      // Erfolg ODER bereits abgestimmt → Ergebnis zeigen + frische Zahlen holen.
      setJustVoted(true);
      // Beleg-Code nur bei frischer Stimme (nie bei alreadyVoted) — einmalige Anzeige.
      setBeleg(result.beleg ?? null);
      setPhase("ergebnis");
      router.refresh();
    } catch {
      setError("Verbindungsfehler — bitte erneut versuchen.");
    } finally {
      setSubmitting(null);
    }
  }

  // Nicht eingeloggt (oder needLogin aus der Action): Ergebnis + Anmelde-CTA.
  // Demo-Spielwiese: Buttons bleiben direkt tappbar (handleVote legt bei Bedarf
  // ein ephemeres Demo-Konto an) — kein Anmelde-Hindernis auf der Demo.
  if ((!eingeloggt || needLogin) && !demoMode) {
    return (
      <div>
        <Ergebnisanzeige ergebnis={ergebnis} verbindlich={verbindlich} />
        <AnmeldeCta tenantSlug={tenantSlug} />
      </div>
    );
  }

  // Eingeloggt, aber (noch) nicht wohnsitz-verifiziert und die Abstimmung ist
  // verbindlich → kein Sackgassen-Verbot, sondern positiver Stufen-Fortschritt
  // (Ergebnis bleibt sichtbar). Ausnahme: wer bereits abgestimmt hat (z. B. die
  // Verifizierung lief nach der Stimme ab), sieht weiter das Ergebnis.
  if (verbindlich && !verifiziert && !bereitsAbgestimmt) {
    return (
      <div>
        <Ergebnisanzeige ergebnis={ergebnis} verbindlich={verbindlich} />
        <div className="mt-5 border-t border-[color:var(--pz-line)] pt-5">
          <StufenFortschritt stufe={1} tenantSlug={tenantSlug} variant="card" />
        </div>
      </div>
    );
  }

  if (phase === "ergebnis") {
    return (
      <div>
        {justVoted && (
          <div className="mb-5 flex flex-col items-center gap-3 text-center" role="status">
            <span
              className="flex h-16 w-16 items-center justify-center rounded-full"
              style={{ backgroundColor: "var(--pz-success-soft)", color: "var(--pz-success-ink)" }}
            >
              <BadgeCheck aria-hidden className="h-8 w-8" strokeWidth={2} />
            </span>
            <div>
              <h3 className="text-xl font-semibold" style={{ color: "var(--pz-ink)" }}>
                Ihre Stimme wurde anonym gezählt
              </h3>
              <p className="mt-1 text-sm" style={{ color: "var(--pz-body)" }}>
                Danke fürs Mitmachen.
              </p>
            </div>
          </div>
        )}
        {justVoted && beleg && <BelegCard code={beleg} />}
        <Ergebnisanzeige ergebnis={ergebnis} verbindlich={verbindlich} />

        {/* Dezente Folge-CTAs nach der Abstimmung. */}
        <div className="mt-6 border-t border-[color:var(--pz-line)] pt-5">
          <p className="text-sm font-medium" style={{ color: "var(--pz-ink)" }}>
            Weitermachen
          </p>
          <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
            <Link
              href={`/${tenantSlug}/umfragen`}
              className="underline-offset-2 hover:underline"
            >
              Alle Abstimmungen ansehen
            </Link>
            {" · "}
            <Link
              href={`/${tenantSlug}/digest`}
              className="underline-offset-2 hover:underline"
            >
              Ratsinfos lesen
            </Link>
          </p>
        </div>
      </div>
    );
  }

  // Phase "frage": Buttons (eingeloggt)
  return (
    <div>
      {/* Vote-Tap-Flächen (Design-System): voll-breite Felder mit rundem Icon-Badge,
          alle drei GLEICHWERTIG (gleiche Marke/Größe) — Neutralität gewahrt. */}
      <div className="flex flex-col gap-3">
        {(["ja", "nein", "enthaltung"] as Choice[]).map((c) => {
          const Icon = CHOICE_ICONS[c];
          return (
            <button
              key={c}
              type="button"
              onClick={() => handleVote(c)}
              disabled={submitting !== null}
              aria-busy={submitting === c}
              className="flex w-full items-center gap-3 rounded-xl border-2 bg-white px-[18px] py-[18px] text-left text-lg font-semibold shadow-sm transition-colors hover:bg-[color:var(--pz-brand-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-2 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderColor: "var(--pz-brand)", color: "var(--pz-brand-strong)" }}
            >
              <span
                aria-hidden
                className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full"
                style={{ backgroundColor: "var(--pz-brand-soft)" }}
              >
                {submitting === c ? "…" : <Icon className="h-[19px] w-[19px]" strokeWidth={2} />}
              </span>
              {CHOICE_LABELS[c]}
            </button>
          );
        })}
      </div>

      {error && (
        <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-4 flex items-start gap-2 text-sm" style={{ color: "var(--pz-muted)" }}>
        <Lock aria-hidden className="mt-0.5 h-[15px] w-[15px] shrink-0" style={{ color: "var(--pz-brand-strong)" }} strokeWidth={2} />
        <span>
          {verbindlich
            ? "Verbindliche Abstimmung — Ihre wohnsitz-verifizierte Stimme wird gewertet, bleibt aber geheim."
            : "Geheime Wahl: Ihre Antwort wird nur als anonyme Stimme gezählt — nie mit Ihrem Namen gespeichert."}
        </span>
      </div>

      {/* Ehrlichkeits-Hinweis der Spielwiese: die Konto-Pflicht ist hier nur
          vereinfacht (Wegwerf-Konto), nicht abgeschafft. */}
      {demoMode && !eingeloggt && (
        <p className="mt-2 text-xs" style={{ color: "var(--pz-muted)" }}>
          Demo-Vereinfachung: Ihre Stimme läuft über ein Wegwerf-Demo-Konto.
          Im Echtbetrieb melden sich Bürger:innen per E-Mail-Link an (~30 Sekunden).
        </p>
      )}
    </div>
  );
}
