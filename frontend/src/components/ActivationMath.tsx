"use client";

// The activation math, live from the chain: what it costs to switch a Broker on today,
// and what the engine actually distributed over the last 24h per active Broker. Purpose:
// make the difference between an inactive shell and a working Broker legible at the
// moment someone is looking at floor listings — with data, not promises.
//
// All figures are recomputed from public reads (no backend): activation cost from the
// router's own quote, distribution from the Booster's Bought events valued at the same
// feeds the contract uses. Cached in localStorage via useStoredQuery so a reload costs
// zero RPC while fresh.

import { formatUnits, parseAbiItem, zeroAddress } from "viem";
import { ADDR, OPENSEA_URL, PARAMS } from "@/lib/config";
import { boosterAbi, routerAbi, aggregatorAbi } from "@/lib/abis";
import { publicClient as client } from "@/lib/client";
import { loadKnownTokens } from "@/lib/brokerValue";
import { useStoredQuery } from "@/lib/useStoredQuery";

const BOUGHT = parseAbiItem("event Bought(address indexed token, uint256 ethIn, uint256 tokenOut)");
// ~24h of blocks with slack; the timestamp filter below does the exact cut.
const LOOKBACK_BLOCKS = 2_200_000n;

type MathData = {
  activationUsd: number | null;
  dist24hUsd: number;
  perActiveUsd: number | null;
  active: number;
};

async function loadMath(): Promise<MathData> {
  const [latest, activeRaw] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "activeShares" }),
  ]);
  const active = Number(activeRaw);

  // Activation cost in USD: ETH/USD (Booster's own feed) ÷ COAT-per-ETH (router quote).
  let activationUsd: number | null = null;
  try {
    const feed = (await client.readContract({
      address: ADDR.booster, abi: boosterAbi, functionName: "ethUsdFeed",
    })) as `0x${string}`;
    if (feed && feed !== zeroAddress && ADDR.router) {
      const [dec, rd, coatPerEth] = await Promise.all([
        client.readContract({ address: feed, abi: aggregatorAbi, functionName: "decimals" }),
        client.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" }),
        client.readContract({
          address: ADDR.router as `0x${string}`, abi: routerAbi, functionName: "quoteBuy", args: [10n ** 18n],
        }),
      ]);
      const ethUsd = Number(formatUnits(rd[1] as bigint, Number(dec)));
      const perEth = Number(formatUnits(coatPerEth as bigint, 18));
      if (ethUsd > 0 && perEth > 0) activationUsd = (ethUsd / perEth) * PARAMS.activationBurn;
    }
  } catch { /* renders "—" */ }

  // Everything the engine bought in the last 24h, valued at the contract's own feeds.
  let dist24hUsd = 0;
  try {
    const from = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;
    const [logs, metas, nowBlock, fromBlockHdr] = await Promise.all([
      client.getLogs({ address: ADDR.booster, event: BOUGHT, fromBlock: from }),
      loadKnownTokens(),
      client.getBlock({ blockNumber: latest }),
      client.getBlock({ blockNumber: from }),
    ]);
    const nowTs = Number(nowBlock.timestamp);
    const cutoff = nowTs - 24 * 3600;
    // Pokes land in bursts: many Bought logs share a block, so timestamp per unique block —
    // but only for blocks that can plausibly be inside the 24h window. The window edges give
    // an average block time; anything older than ~28h by that estimate is skipped without a
    // fetch, which keeps this to ~one header per poke instead of one per lookback block.
    const spanSecs = nowTs - Number(fromBlockHdr.timestamp);
    const secsPerBlock = spanSecs > 0 ? spanSecs / Number(latest - from) : 1;
    const approxCutoffBlock = latest - BigInt(Math.ceil((28 * 3600) / secsPerBlock));
    const blocks = [...new Set(logs.map((l) => l.blockNumber!))].filter((b) => b >= approxCutoffBlock);
    const ts = new Map<bigint, number>();
    await Promise.all(
      blocks.map(async (b) => {
        try { ts.set(b, Number((await client.getBlock({ blockNumber: b })).timestamp)); } catch { /* skip */ }
      }),
    );
    for (const l of logs) {
      const t = ts.get(l.blockNumber!);
      if (t === undefined || t < cutoff) continue;
      const meta = metas.find((m) => m.token.toLowerCase() === (l.args.token as string).toLowerCase());
      if (!meta) continue;
      dist24hUsd += Number(formatUnits(l.args.tokenOut as bigint, meta.decimals)) * meta.priceUsd;
    }
  } catch { /* stays 0 with the caveat line visible */ }

  return {
    activationUsd,
    dist24hUsd,
    perActiveUsd: active > 0 ? dist24hUsd / active : null,
    active,
  };
}

function usd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: n < 100 ? 2 : 0 });
}

/** The same cached query the home panel uses; any tab can read today's per-Broker rate. */
export function useActivationMath() {
  return useStoredQuery<MathData>({
    storageKey: "coattail.activationmath.v1",
    queryKey: ["activation-math"],
    queryFn: loadMath,
    staleTime: 10 * 60_000,
    refetchInterval: 15 * 60_000,
    persistIf: (d) => d.dist24hUsd > 0,
  });
}

export function ActivationMath({ onNavigate }: { onNavigate: (tab: "activate") => void }) {
  const { data } = useStoredQuery<MathData>({
    storageKey: "coattail.activationmath.v1",
    queryKey: ["activation-math"],
    queryFn: loadMath,
    staleTime: 10 * 60_000,
    refetchInterval: 10 * 60_000,
    ssrSafe: true,
  });

  const stats = [
    { k: "Activation cost now", v: data ? `${PARAMS.activationBurn.toLocaleString("en-US")} $COAT ≈ ${usd(data.activationUsd)}` : "—" },
    { k: "Distributed last 24h", v: data ? usd(data.dist24hUsd) : "—" },
    { k: "Per active broker · 24h", v: data ? usd(data.perActiveUsd) : "—" },
    { k: "Active & earning", v: data ? `${data.active.toLocaleString("en-US")} / 1,776` : "—" },
  ];

  return (
    <section className="card">
      <h2 className="pixel-title text-[15px] mb-1">Shell, or working Broker?</h2>
      <p className="text-ink-soft text-sm mb-4 max-w-2xl">
        Most Brokers listed near the floor are switched <b className="text-ink-strong">off</b> — shells that
        earn nothing. The same NFT, activated, earns a share of every buy the engine makes. The
        difference, live from the chain:
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stats.map((s) => (
          <div key={s.k} className="stat">
            <div className="text-[11px] text-ink-soft uppercase tracking-widest">{s.k}</div>
            <div className="font-pixel text-[13px] sm:text-sm text-ink-strong mt-1 break-words">{s.v}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 mt-4">
        <a className="btn btn-accent text-[11px] px-3 py-2.5" href={OPENSEA_URL} target="_blank" rel="noopener noreferrer">
          Browse OpenSea &#8599;
        </a>
        <button className="btn btn-ghost text-[11px] px-3 py-2.5" onClick={() => onNavigate("activate")}>
          Activate yours &#8594;
        </button>
      </div>
      <p className="text-ink-soft text-[11px] mt-3">
        Distribution comes from real trading fees and varies with volume — the last 24h is a
        measurement, not a promise. Every number above is recomputed from public chain data.
      </p>
    </section>
  );
}
