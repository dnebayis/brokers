"use client";

import { useEffect, useState } from "react";
import { ADDR } from "@/lib/config";
import { boosterAbi, aggregatorAbi } from "@/lib/abis";
import { FLOOR } from "@/lib/floor";
import { publicClient as client } from "@/lib/client";

// How long a stock feed may sit unchanged before the contracts refuse to price
// against it. Read from the router so the sign and the guard can never disagree;
// this constant is only the fallback while The Floor is not configured.
const DEFAULT_STALE_AFTER = 86_400n;

const staleAfterAbi = [
  { type: "function", name: "feedStaleAfter", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

// The shop-door sign. Hangs itself when the stock price feeds go stale (the market
// closed: nights are inside the staleness window, so in practice this is weekends
// and holidays) and takes itself down on the first fresh price after the opening
// bell. Driven by the same on-chain reads the trading guards use, never by a
// calendar, so it is right about half-days and holidays without knowing about them.
export function MarketClosedSign() {
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const token = (await client.readContract({
          address: ADDR.booster,
          abi: boosterAbi,
          functionName: "knownTokens",
          args: [0n],
        })) as `0x${string}`;
        const feed = (await client.readContract({
          address: ADDR.booster,
          abi: boosterAbi,
          functionName: "stockFeed",
          args: [token],
        })) as `0x${string}`;
        const rd = (await client.readContract({
          address: feed,
          abi: aggregatorAbi,
          functionName: "latestRoundData",
        })) as readonly [bigint, bigint, bigint, bigint, bigint];
        let staleAfter = DEFAULT_STALE_AFTER;
        if (FLOOR.router !== "") {
          staleAfter = (await client.readContract({
            address: FLOOR.router,
            abi: staleAfterAbi,
            functionName: "feedStaleAfter",
          })) as bigint;
        }
        const age = BigInt(Math.floor(Date.now() / 1000)) - rd[3];
        if (!cancelled) setClosed(age > staleAfter);
      } catch {
        // an unreadable feed proves nothing; leave the door as it was
      }
    }

    check();
    const iv = setInterval(check, 60_000); // lifts itself at the opening bell
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  if (!closed) return null;

  return (
    <div className="mb-6 w-full max-w-2xl mx-auto flex flex-col items-center" aria-label="Market closed">
      {/* the string it hangs from */}
      <div className="flex gap-16">
        <div className="w-[3px] h-5 bg-ink" />
        <div className="w-[3px] h-5 bg-ink" />
      </div>
      <div className="w-full border-2 border-ink bg-cream-2 shadow-pixel-sm -rotate-1 px-5 py-4 text-center">
        <div className="font-pixel text-base text-accent tracking-wide">MARKET CLOSED</div>
        <p className="mt-2 text-ink-soft text-sm">
          Stock price feeds froze at the closing bell, and The Floor will not trade at a
          price it cannot verify. Buying and selling wait here until the market reopens.
        </p>
        <p className="mt-2 text-ink-soft text-sm">
          Nothing stops earning meanwhile: fees keep piling into the Booster, and the first
          fresh price after the opening bell spends all of them at once. This sign takes
          itself down at that moment.
        </p>
      </div>
    </div>
  );
}
