"use client";

import { useState } from "react";
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
  wallet,
}: {
  id: bigint;
  active: boolean;
  selected?: boolean;
  onSelect?: () => void;
  backingUsd?: number;
  earnedUsd?: number;
  /** The Broker's own on-chain (ERC-6551) wallet address, for one-tap copying. */
  wallet?: string;
}) {
  const [copied, setCopied] = useState(false);
  const money = (n: number) =>
    n < 0.005
      ? "$0"
      : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 100 ? 2 : 0 });
  function copyWallet(e: React.MouseEvent) {
    // The row itself is a select button — copying must not also select.
    e.stopPropagation();
    if (!wallet) return;
    navigator.clipboard.writeText(wallet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
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
        {wallet && (
          <span
            role="button"
            tabIndex={0}
            onClick={copyWallet}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") copyWallet(e as unknown as React.MouseEvent); }}
            title="Copy this Broker's wallet address"
            className={`inline-flex items-center gap-1 mt-1 font-mono text-[10px] cursor-pointer border px-1.5 py-0.5 transition-colors ${
              copied ? "border-good text-good" : "border-line text-ink-soft hover:text-ink-strong hover:border-ink"
            }`}
          >
            {copied ? "copied ✓" : `${wallet.slice(0, 6)}…${wallet.slice(-4)} ⧉`}
          </span>
        )}
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
