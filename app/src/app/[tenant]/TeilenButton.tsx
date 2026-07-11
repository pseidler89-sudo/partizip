/**
 * TeilenButton.tsx — Abstimmung teilen (Spread). Client-Komponente.
 *
 * Bietet: native Teilen (navigator.share, v.a. mobil) mit Fallback auf Kopieren,
 * Link kopieren, Teilen per E-Mail (mailto). Kein WhatsApp-Button mehr
 * (ADR-021 Kanal-Souveränität: keine proprietären US-Silos in der eigenen UI;
 * Messenger bleiben über das native Teilen-Sheet nutzerinitiiert erreichbar).
 *
 * SSR-Stabilität: Die absolute URL wird ERST BEIM KLICK aus
 * window.location.origin gebaut — kein useEffect/State-Ableiten (vermeidet
 * Hydration-Mismatch und set-state-in-effect). Auch mailto wird deshalb beim
 * Klick via window.location.href geöffnet statt als SSR-href-Attribut.
 */

"use client";

import { useState } from "react";
import { Share2, Link as LinkIcon, Check, Mail } from "lucide-react";

interface Props {
  title: string;
  path: string;
}

const TEXT_BAUSTEIN = "Machen Sie mit – Ihre Stimme zählt:";

export function TeilenButton({ title, path }: Props) {
  const [copied, setCopied] = useState(false);

  function absUrl(): string {
    return typeof window !== "undefined" ? `${window.location.origin}${path}` : path;
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const el = document.createElement("textarea");
      el.value = url;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.focus();
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  async function handleTeilen() {
    const url = absUrl();
    const text = `${title}\n\n${TEXT_BAUSTEIN}`;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch {
        /* abgebrochen / nicht möglich → Fallback */
      }
    }
    await copy(url);
  }

  function handleEmail() {
    const url = absUrl();
    const body = `${TEXT_BAUSTEIN}\n\n${url}`;
    window.location.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  }

  const pill =
    "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors " +
    "hover:bg-[color-mix(in_srgb,var(--pz-brand)_8%,transparent)] " +
    "hover:border-[color-mix(in_srgb,var(--pz-brand)_35%,var(--pz-line))] " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--pz-brand)] focus-visible:ring-offset-1";
  const pillStyle = { borderColor: "var(--pz-line)", color: "var(--pz-ink)" } as const;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs uppercase tracking-wide" style={{ color: "var(--pz-muted)" }}>
        Teilen
      </span>

      <button type="button" onClick={handleTeilen} className={pill} style={pillStyle}>
        <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
        Teilen…
      </button>

      <button
        type="button"
        onClick={() => copy(absUrl())}
        className={pill}
        style={
          copied
            ? {
                borderColor: "var(--pz-success)",
                color: "var(--pz-success-ink)",
                backgroundColor: "var(--pz-success-soft)",
              }
            : pillStyle
        }
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span aria-live="polite">{copied ? "Link kopiert!" : "Link kopieren"}</span>
      </button>

      <button type="button" onClick={handleEmail} className={pill} style={pillStyle}>
        <Mail className="h-3.5 w-3.5" aria-hidden="true" />
        Per E-Mail
      </button>
    </div>
  );
}
