"use client";

import { Terminal } from "@/components/trade/Terminal";

export default function TradePage() {
  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <h1 className="font-pixel text-lg text-ink-strong mb-4">The Floor</h1>
      <Terminal />
    </main>
  );
}
