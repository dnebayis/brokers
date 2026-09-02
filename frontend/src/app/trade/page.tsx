"use client";

import { Terminal } from "@/components/trade/Terminal";
import { CoatSwap } from "@/components/trade/CoatSwap";
import { RoutingNotice } from "@/components/trade/RoutingNotice";

export default function TradePage() {
  return (
    <main className="mx-auto max-w-xl px-6 py-10 grid gap-5">
      <div>
        <h1 className="font-pixel text-lg text-ink-strong mb-4">The Floor</h1>
        <Terminal />
      </div>
      <RoutingNotice />
      <CoatSwap />
    </main>
  );
}
