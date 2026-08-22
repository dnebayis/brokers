"use client";

import { BrokerArtwork } from "@/components/ui/BrokerArtwork";

// One owned Broker as a full-width row: artwork left, identity + status, then the two
// figures that matter (what's inside it now, what it earned since the owner switched it
// on). Rows beat a thumbnail grid here — the numbers stay readable at any count, and
// nothing hides behind hover, which touch devices don't have.
export function BrokerCard({
  id,
  active,
  selected,
  onSelect,
  backingUsd,
  earnedUsd,
}: {
  id: bigint;
  active: boolean;
  selected?: boolean;
  onSelect?: () => void;
  backingUsd?: number;
  earnedUsd?: number;
}) {
  const money = (n: number) =>
    n < 0.005
      ? "$0"
      : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 100 ? 2 : 0 });
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left bg-cream-2 border-2 p-2.5 shadow-pixel-sm transition-transform hover:-translate-y-0.5 flex items-center gap-3 ${
        selected ? "border-accent" : "border-ink"
      }`}
    >
      <div className="border border-line bg-cream shrink-0">
        <BrokerArtwork tokenId={id} size={56} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-pixel text-[12px] text-ink-strong">#{id.toString()}</span>
          <span
            className={`font-pixel text-[9px] px-1.5 py-0.5 border ${
              active ? "border-good text-good" : "border-ink-soft text-ink-soft"
            }`}
          >
            {active ? "ON" : "OFF"}
          </span>
        </div>
        <div className="text-[11px] text-ink-soft mt-1 truncate">
          {backingUsd !== undefined ? <>Holds {money(backingUsd)} of stock</> : "On-chain artwork"}
        </div>
      </div>
      <div className="text-right shrink-0">
        {earnedUsd !== undefined ? (
          <>
            <div className="font-pixel text-[12px] text-good">{money(earnedUsd)}</div>
            <div className="text-[10px] text-ink-soft mt-0.5">earned since switch-on</div>
          </>
        ) : (
          <div className="text-[10px] text-ink-soft">not activated yet</div>
        )}
      </div>
    </button>
  );
}
