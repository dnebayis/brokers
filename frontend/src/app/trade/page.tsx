"use client";

import { useEffect, useState } from "react";
import { FLOOR } from "@/lib/floor";
import { Terminal } from "@/components/trade/Terminal";
import { MarketClosedSign } from "@/components/MarketClosedSign";

export default function TradePage() {
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    // Next 16 gotcha (campaign page lesson): read location.search in a mount effect,
    // never through useSearchParams, or the page wedges in Suspense forever.
    setPreview(new URLSearchParams(window.location.search).get("preview") === "1");
  }, []);

  if (!FLOOR.live && !preview) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-24 text-center">
        <h1 className="font-pixel text-lg text-ink-strong">The Floor</h1>
        <p className="mt-4 text-ink-soft">This room is being furnished. Check back soon.</p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <h1 className="font-pixel text-lg text-ink-strong mb-4">The Floor</h1>
      <MarketClosedSign />
      <Terminal />
    </main>
  );
}
