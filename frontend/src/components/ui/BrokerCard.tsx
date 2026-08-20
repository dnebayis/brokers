"use client";

import { BrokerArtwork } from "@/components/ui/BrokerArtwork";

export function BrokerCard({
  id,
  active,
  selected,
  onSelect,
  backingUsd,
}: {
  id: bigint;
  active: boolean;
  selected?: boolean;
  onSelect?: () => void;
  backingUsd?: number;
}) {
  return (
    <button
      onClick={onSelect}
      className={`text-left bg-cream-2 border-2 p-2 shadow-pixel-sm transition-transform hover:-translate-y-0.5 ${
        selected ? "border-accent" : "border-ink"
      }`}
    >
      <div className="border border-line bg-cream">
        <BrokerArtwork tokenId={id} size={104} />
      </div>
      <div className="flex items-center justify-between mt-1.5">
        <span className="font-pixel text-[11px] text-ink-strong">#{id.toString()}</span>
        <span
          className={`font-pixel text-[9px] px-1.5 py-0.5 border ${
            active ? "border-good text-good" : "border-ink-soft text-ink-soft"
          }`}
        >
          {active ? "ON" : "OFF"}
        </span>
      </div>
      <div className="text-[10px] text-ink-soft mt-0.5 truncate">
        {backingUsd !== undefined
          ? `Backed by ${backingUsd < 0.005 ? "$0" : backingUsd.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: backingUsd < 100 ? 2 : 0 })}`
          : "On-chain artwork"}
      </div>
    </button>
  );
}
