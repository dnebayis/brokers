"use client";

import { BrokerAvatar, traitsOf } from "@/lib/brokerArt";

export function BrokerCard({
  id,
  active,
  selected,
  onSelect,
}: {
  id: bigint;
  active: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const t = traitsOf(id);
  return (
    <button
      onClick={onSelect}
      className={`text-left bg-cream-2 border-2 p-2 shadow-pixel-sm transition-transform hover:-translate-y-0.5 ${
        selected ? "border-accent" : "border-ink"
      }`}
    >
      <div className="border border-line bg-cream">
        <BrokerAvatar tokenId={id} size={104} />
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
        {t.type} · {t.accessory !== "None" ? t.accessory : t.eyes !== "None" ? t.eyes : t.headwear}
      </div>
    </button>
  );
}
