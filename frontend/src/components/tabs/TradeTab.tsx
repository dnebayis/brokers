"use client";

import { Terminal } from "@/components/trade/Terminal";
import { CoatSwap } from "@/components/trade/CoatSwap";
import { RoutingNotice } from "@/components/trade/RoutingNotice";

export function TradeTab() {
  return (
    <div className="max-w-xl grid gap-5">
      <div>
        <h1 className="font-pixel text-lg text-ink-strong mt-1 mb-4">The Floor</h1>
        <Terminal />
      </div>
      <RoutingNotice />
      <CoatSwap />
    </div>
  );
}
