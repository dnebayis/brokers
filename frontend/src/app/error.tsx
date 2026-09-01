"use client";

import { useEffect } from "react";

export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto max-w-xl px-6 py-24 text-center">
      <h1 className="font-pixel text-lg text-ink-strong">Something broke on this screen</h1>
      <p className="mt-4 text-ink-soft">
        Your wallet and your Brokers are untouched — this is a display error, not a chain error.
        Nothing on-chain moved.
      </p>
      <button className="btn btn-accent mt-6" onClick={() => retry()}>
        Try again
      </button>
    </main>
  );
}
