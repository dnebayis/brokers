"use client";

import { useState } from "react";
import { BrokerArtwork } from "@/components/ui/BrokerArtwork";

// One owned Broker as a full-width row: artwork left, identity + status, then the two
// figures that matter (what's inside it now, what it earned since the owner switched it
// on). Rows beat a thumbnail grid here — the numbers stay readable at any count, and
// nothing hides behind hover, which touch devices don't have.
//
// The card border belongs to a plain wrapper: the select control and the copy-wallet
// control are sibling <button>s inside it, never nested (a button inside a button is
// invalid HTML and reads as one control to screen readers).
export function BrokerCard({
  id,
  active,
  selected,
  onSelect,
  backingUsd,
  earnedUsd,
  wallet,
  coatInside,
}: {
  id: bigint;
  active: boolean | null;
  selected?: boolean;
  onSelect?: () => void;
  backingUsd?: number;
  earnedUsd?: number;
  /** The Broker's own on-chain (ERC-6551) wallet address, for one-tap copying. */
  wallet?: string;
  /** $COAT held inside that wallet (18 decimals); shown only when non-zero. */
  coatInside?: bigint;
}) {
  const [copied, setCopied] = useState(false);
  const money = (n: number) =>
    n < 0.005
      ? "$0"
      : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 100 ? 2 : 0 });
  function copyWallet() {
    if (!wallet) return;
    navigator.clipboard.writeText(wallet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div
      className={`w-full bg-cream-2 border-2 shadow-pixel-sm transition-transform hover:-translate-y-0.5 ${
        selected ? "border-accent" : "border-ink"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected ?? undefined}
        className="w-full text-left p-2.5 flex items-center gap-3"
      >
        <div className="border border-line bg-cream shrink-0">
          <BrokerArtwork tokenId={id} size={56} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-pixel text-[12px] text-ink-strong">#{id.toString()}</span>
            <span
              className={`font-pixel text-[9px] px-1.5 py-0.5 border ${
                active === null
                  ? "border-ink-soft text-ink-soft opacity-60"
                  : active
                    ? "border-good text-good"
                    : "border-ink-soft text-ink-soft"
              }`}
            >
              {active === null ? "…" : active ? "ON" : "OFF"}
            </span>
          </div>
          <div className="text-[11px] text-ink-soft mt-1 truncate">
            {backingUsd !== undefined ? <>Holds {money(backingUsd)} of stock</> : "On-chain artwork"}
            {coatInside !== undefined && coatInside > 0n && (
              <span className="ml-2 font-pixel text-[9px] text-accent border border-accent px-1 py-0.5 align-middle">
                +{Math.floor(Number(coatInside) / 1e18).toLocaleString("en-US")} $COAT inside
              </span>
            )}
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
      {wallet && (
        <div className="px-2.5 pb-2 -mt-1 pl-[82px]">
          <button
            type="button"
            onClick={copyWallet}
            title="Copy this Broker's wallet address"
            aria-label={copied ? "Wallet address copied" : `Copy wallet address ${wallet}`}
            className={`inline-flex items-center gap-1 font-mono text-[10px] min-h-[28px] border px-2 transition-colors ${
              copied ? "border-good text-good" : "border-line text-ink-soft hover:text-ink-strong hover:border-ink"
            }`}
          >
            {copied ? "copied ✓" : `${wallet.slice(0, 6)}…${wallet.slice(-4)} ⧉`}
          </button>
        </div>
      )}
    </div>
  );
}
