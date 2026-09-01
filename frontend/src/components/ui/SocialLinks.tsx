"use client";

import { useState } from "react";
import { ADDR, LINKS } from "@/lib/config";

// The project's public doors (X, Discord, OpenSea) plus the $COAT contract address with a
// one-tap copy. Two densities: icon-only for the header, labelled for panels and the
// footer. Brand marks are inline so nothing is fetched for them.
const ICONS = {
  x: (
    <path d="M17.5 3h3.1l-6.8 7.8L21.8 21h-6.3l-4.9-6.4L5 21H1.9l7.3-8.3L1.5 3h6.4l4.4 5.9L17.5 3Zm-1.1 16.2h1.7L7 4.7H5.2l11.2 14.5Z" />
  ),
  discord: (
    <path d="M19.6 5.4A16 16 0 0 0 15.7 4l-.2.4a13 13 0 0 1 3.6 1.8 14 14 0 0 0-14.2 0A13 13 0 0 1 8.5 4.4L8.3 4a16 16 0 0 0-3.9 1.4C2 9 1.3 12.6 1.6 16.1a16 16 0 0 0 4.9 2.4l1-1.6a10 10 0 0 1-1.6-.8l.4-.3a11.5 11.5 0 0 0 11.4 0l.4.3a10 10 0 0 1-1.6.8l1 1.6a16 16 0 0 0 4.9-2.4c.4-4-.7-7.6-2.8-10.7ZM8.7 14c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" />
  ),
  opensea: (
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM6.4 12.4l.1-.1 2.9-4.5c0-.1.2-.1.2 0 .5 1.1.9 2.5.7 3.3-.1.4-.3.9-.6 1.3H6.5a.1.1 0 0 1-.1-.1v.1Zm11.4 1.3c0 .1 0 .1-.1.1-.3.1-1.3.6-1.7 1.2-1 1.5-1.8 3.6-3.6 3.6H8.6a4.9 4.9 0 0 1-4.9-4.9v-.1l.1-.1h4.2c.1 0 .2.1.1.2v.6c0 .4.3.8.8.8h2.1v-1.5H9.5c.5-.7 1-1.6.9-2.5-.1-.9-.6-2.2-1-3.2l1-.1v.1c.3.4.6 1.1.6 1.1v.1c.3.7.4 1.3.3 1.9 0 .2-.1.4-.2.6h.5v-3.4l-.7-.2.4-1.2v-.1l-.7-2.5c0-.1.1-.2.2-.1l1.1.8v-1.2h1v1.2c1.7 1 3.1 2.8 3.1 4.9v.4a3.4 3.4 0 0 1-.1.6h1.2c.2 0 .3.2.2.3-.1.2-.2.4-.3.5Z" />
  ),
} as const;

const ITEMS: { key: keyof typeof ICONS; label: string; href: string }[] = [
  { key: "x", label: "X", href: LINKS.x },
  { key: "discord", label: "Discord", href: LINKS.discord },
  { key: "opensea", label: "OpenSea", href: LINKS.opensea },
];

function Mark({ name, className = "w-4 h-4" }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

export function CoatAddress({ compact = false }: { compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const a = ADDR.coat;
  const shown = compact ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard.writeText(a).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      title="Copy the $COAT contract address"
      aria-label={copied ? "Contract address copied" : "Copy the $COAT contract address"}
      className={`inline-flex items-center gap-1.5 font-mono text-[11px] min-h-[32px] border px-2 transition-colors ${
        copied ? "border-good text-good" : "border-line text-ink-soft hover:text-ink-strong hover:border-ink"
      }`}
    >
      <span className="font-pixel text-[9px] uppercase tracking-widest">CA</span>
      <span className="break-all">{copied ? "copied ✓" : shown}</span>
    </button>
  );
}

export function SocialLinks({ variant = "icons" }: { variant?: "icons" | "labels" }) {
  if (variant === "icons") {
    return (
      <nav aria-label="Community links" className="flex items-center gap-1">
        {ITEMS.map((it) => (
          <a
            key={it.key}
            href={it.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={it.label}
            title={it.label}
            className="w-9 h-9 grid place-items-center text-ink-soft hover:text-ink-strong transition-colors"
          >
            <Mark name={it.key} className="w-[18px] h-[18px]" />
          </a>
        ))}
      </nav>
    );
  }
  return (
    <nav aria-label="Community links" className="flex flex-wrap items-center gap-2">
      {ITEMS.map((it) => (
        <a
          key={it.key}
          href={it.href}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-ghost text-[11px] px-3 py-2 min-h-[36px]"
        >
          <Mark name={it.key} />
          {it.label}
        </a>
      ))}
      <a
        href={LINKS.coatOnOpenSea}
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-ghost text-[11px] px-3 py-2 min-h-[36px]"
      >
        $COAT on OpenSea ↗
      </a>
    </nav>
  );
}
