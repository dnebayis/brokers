"use client";

import { useEffect, useState } from "react";

// The page-level safety net. Two jobs beyond saying sorry: (1) a stale tab that outlived a
// deploy fails to load the new build's chunks — that is fixed by one full reload, so do it
// automatically, once; (2) any other error shows its actual message, so a holder can paste
// what broke instead of describing a blank screen.

const RELOAD_FLAG = "coattail.errorReload";

function looksLikeStaleBuild(err: Error): boolean {
  const text = `${err.name} ${err.message}`;
  return /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|css chunk/i.test(text);
}

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    console.error(error);
    if (!looksLikeStaleBuild(error)) return;
    try {
      if (sessionStorage.getItem(RELOAD_FLAG)) return; // already tried once this session
      sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
      setReloading(true);
      window.location.reload();
    } catch {
      /* storage blocked: fall through to the manual buttons */
    }
  }, [error]);

  const detail = `${error.name || "Error"}: ${error.message || "no message"}`.slice(0, 400);

  return (
    <main className="mx-auto max-w-xl px-6 py-24 text-center">
      <h1 className="font-pixel text-lg text-ink-strong">Something broke on this screen</h1>
      <p className="mt-4 text-ink-soft">
        Your wallet and your Brokers are untouched — this is a display error, not a chain error.
        Nothing on-chain moved.
      </p>
      {reloading ? (
        <p className="mt-6 text-ink-soft text-sm">A newer version of the site is live — reloading…</p>
      ) : (
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button className="btn btn-accent" onClick={() => window.location.reload()}>
            Reload the page
          </button>
          <button className="btn btn-ghost" onClick={() => retry()}>
            Try again
          </button>
        </div>
      )}
      <details className="mt-8 text-left">
        <summary className="text-ink-soft text-xs cursor-pointer">what broke (for support)</summary>
        <pre className="mt-2 text-[11px] text-ink-soft whitespace-pre-wrap break-all border border-line rounded p-3">
          {detail}
          {error.digest ? `\ndigest: ${error.digest}` : ""}
          {typeof navigator !== "undefined" ? `\n${navigator.userAgent}` : ""}
        </pre>
      </details>
    </main>
  );
}
