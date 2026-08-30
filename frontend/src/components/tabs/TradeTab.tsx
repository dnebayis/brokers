"use client";

import { Terminal } from "@/components/trade/Terminal";
import { MarketClosedSign } from "@/components/MarketClosedSign";

export function TradeTab() {
  return (
    <div className="max-w-xl">
      <h1 className="font-pixel text-lg text-ink-strong mt-1 mb-4">The Floor</h1>
      <MarketClosedSign />
      <Terminal />
    </div>
  );
}
