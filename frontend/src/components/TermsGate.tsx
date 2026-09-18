"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { usePathname } from "next/navigation";
import { TermsBody } from "@/components/legal/TermsContent";
import { TERMS_VERSION, readAcceptedVersion, writeAccepted } from "@/lib/terms";

// One-time acceptance window. It opens on the first visit (and again whenever TERMS_VERSION
// moves), sits over the whole app, cannot be dismissed with Escape or a click outside, and
// only closes on the button. The terms page itself and the public share cards stay open so a
// link to them still reads without the window in the way.
const OPEN_PATHS = [/^\/terms(\/|$)/, /^\/card\//];

export function TermsGate() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const boxId = useId();
  const skip = OPEN_PATHS.some((re) => re.test(pathname ?? ""));

  useEffect(() => {
    if (skip) return;
    setOpen(readAcceptedVersion() !== TERMS_VERSION);
  }, [skip]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLElement>("input, button, a")?.focus();
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled]), a[href]"),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function accept() {
    if (!agreed) return;
    writeAccepted();
    setOpen(false);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] bg-black/60 grid place-items-center p-3 sm:p-6" data-testid="terms-gate">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={boxId}
        className="card w-full max-w-2xl max-h-full overflow-hidden flex flex-col gap-4"
        onKeyDown={onKeyDown}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id={titleId} className="pixel-title text-sm">Before you continue</h2>
          <span className="text-[11px] text-ink-soft">Terms version {TERMS_VERSION}</span>
        </div>
        <p className="text-sm text-ink leading-relaxed">
          This site is a self-service interface for public smart contracts on Robinhood Chain. It is not an offer, not
          advice, and not available everywhere. Read the terms below, then confirm.
        </p>
        <div
          id={boxId}
          tabIndex={0}
          className="fld flex-1 min-h-[140px] max-h-[48vh] overflow-y-auto py-0 focus:shadow-pixel-sm"
        >
          <TermsBody compact />
        </div>
        <label className="flex items-start gap-3 text-sm text-ink-strong cursor-pointer select-none">
          <input
            type="checkbox"
            className="mt-1 w-4 h-4 accent-[var(--c-accent)] shrink-0"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          <span>
            I have read and accept the terms. I am not in a restricted jurisdiction, I am not a sanctioned person, and I
            understand that this site is a user interface only and that nothing on it is financial advice.
          </span>
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <a href="/terms" target="_blank" rel="noreferrer" className="text-xs text-ink-soft underline hover:text-ink-strong">
            Open the terms on their own page
          </a>
          <button type="button" className="btn btn-accent" disabled={!agreed} onClick={accept}>
            I agree, continue
          </button>
        </div>
      </div>
    </div>
  );
}
