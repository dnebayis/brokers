"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { ADDR, OPENSEA_URL } from "@/lib/config";
import { brokerAbi, coatAbi, boosterAbi, routerAbi, aggregatorAbi, erc20Abi } from "@/lib/abis";
import { publicClient as client } from "@/lib/client";

const DEXSCREENER = "https://dexscreener.com/robinhood/0x2d503dda028be83d2e133e5e73a8839f1f202d9f6447e3d863e33ad2c8ebc3d2";
const INITIAL_COAT_SUPPLY = 1_000_000_000; // 1B, fixed at launch
const ZERO = "0x0000000000000000000000000000000000000000";

type Metrics = {
  minted?: number;
  active?: number;
  burned?: number;
  burnedPct?: number;
  priceUsd?: number;
  fdvUsd?: number;
  earnedUsd?: number;
};

function usd(n?: number) {
  if (n === undefined || !isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n >= 1) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 2 });
  return "$" + n.toPrecision(2);
}
function compact(n?: number) {
  if (n === undefined || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

export function HomeMetrics() {
  const [m, setM] = useState<Metrics>({});

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const next: Metrics = {};

      try {
        const [minted, active, supply] = await Promise.all([
          client.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "totalMinted" }),
          client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "activeShares" }),
          client.readContract({ address: ADDR.coat, abi: coatAbi, functionName: "totalSupply" }),
        ]);
        next.minted = Number(minted);
        next.active = Number(active);
        next.burned = INITIAL_COAT_SUPPLY - Number(formatUnits(supply as bigint, 18));
        next.burnedPct = (next.burned / INITIAL_COAT_SUPPLY) * 100;
      } catch { /* leave undefined → renders "—" */ }

      // ETH/USD from the Booster's configured feed (no hardcoded address).
      let ethUsd = 0;
      try {
        const feed = (await client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "ethUsdFeed" })) as `0x${string}`;
        if (feed && feed !== ZERO) {
          const [dec, rd] = await Promise.all([
            client.readContract({ address: feed, abi: aggregatorAbi, functionName: "decimals" }),
            client.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" }),
          ]);
          ethUsd = Number(formatUnits(rd[1] as bigint, Number(dec)));
        }
      } catch { /* price stays undefined */ }

      // $COAT price = ETH/USD ÷ (COAT bought per 1 ETH).
      try {
        if (ADDR.router && ethUsd > 0) {
          const coatPerEth = (await client.readContract({
            address: ADDR.router as `0x${string}`, abi: routerAbi, functionName: "quoteBuy", args: [10n ** 18n],
          })) as bigint;
          const perEth = Number(formatUnits(coatPerEth, 18));
          if (perEth > 0) {
            next.priceUsd = ethUsd / perEth;
            next.fdvUsd = next.priceUsd * INITIAL_COAT_SUPPLY;
          }
        }
      } catch { /* price stays undefined */ }

      // Total stock distributed, valued in USD (feeds already bake in the uiMultiplier).
      // Enumerate the Booster's knownTokens — every token it has EVER bought — not the
      // current basket: when the basket rotates a name out, its historical buys must
      // keep counting or this figure silently shrinks.
      try {
        const count = Number(await client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "knownTokenCount" }));
        const tokens = (await Promise.all(
          Array.from({ length: count }, (_, i) =>
            client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "knownTokens", args: [BigInt(i)] }),
          ),
        )) as readonly `0x${string}`[];
        let total = 0;
        for (const token of tokens) {
          try {
            const [bought, feed, dec] = await Promise.all([
              client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "totalBought", args: [token] }),
              client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "stockFeed", args: [token] }),
              client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
            ]);
            if (!feed || (feed as string) === ZERO) continue;
            const [fdec, rd] = await Promise.all([
              client.readContract({ address: feed as `0x${string}`, abi: aggregatorAbi, functionName: "decimals" }),
              client.readContract({ address: feed as `0x${string}`, abi: aggregatorAbi, functionName: "latestRoundData" }),
            ]);
            const amount = Number(formatUnits(bought as bigint, Number(dec)));
            const price = Number(formatUnits(rd[1] as bigint, Number(fdec)));
            total += amount * price;
          } catch { /* skip this token */ }
        }
        next.earnedUsd = total;
      } catch { /* earned stays undefined */ }

      if (!cancelled) setM(next);
    }

    load();
    // Metrics move on the keeper's hourly cadence; 2 min keeps the UI feeling live at ~1/4 the load.
    const timer = setInterval(load, 120_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const stats: { k: string; v: string }[] = [
    { k: "Brokers", v: m.minted !== undefined ? `${m.minted.toLocaleString("en-US")} / 1,776` : "—" },
    { k: "Active & earning", v: m.active !== undefined ? m.active.toLocaleString("en-US") : "—" },
    { k: "$COAT burned", v: m.burned !== undefined ? `${compact(m.burned)}${m.burnedPct ? ` · ${m.burnedPct.toFixed(1)}%` : ""}` : "—" },
    { k: "Stock distributed", v: usd(m.earnedUsd) },
    { k: "$COAT price", v: usd(m.priceUsd) },
    { k: "Fully-diluted value", v: usd(m.fdvUsd) },
  ];

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="pixel-title text-[15px]">Live metrics</h2>
        <div className="flex gap-2">
          <a href={OPENSEA_URL} target="_blank" rel="noopener noreferrer" className="btn btn-ghost text-[12px] px-3 py-1.5">OpenSea ↗</a>
          <a href={DEXSCREENER} target="_blank" rel="noopener noreferrer" className="btn btn-ghost text-[12px] px-3 py-1.5">DexScreener ↗</a>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {stats.map((s) => (
          <div key={s.k} className="stat">
            <div className="text-[11px] text-ink-soft uppercase tracking-widest">{s.k}</div>
            <div className="font-pixel text-base text-ink-strong mt-1 break-words">{s.v}</div>
          </div>
        ))}
      </div>
      <p className="text-ink-soft text-[11px] mt-3">
        Live from the chain · $COAT burned is removed from supply permanently · stock value uses on-chain feeds.
      </p>
    </section>
  );
}
