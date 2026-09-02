"use client";

import { formatUnits, zeroAddress } from "viem";
import { ADDR, COAT_DROPPED_TOTAL, COAT_DROPS, LINKS, OPENSEA_URL } from "@/lib/config";
import { brokerAbi, coatAbi, boosterAbi, routerAbi, aggregatorAbi, erc20Abi } from "@/lib/abis";
import { publicClient as client } from "@/lib/client";
import { useStoredQuery } from "@/lib/useStoredQuery";

const DEXSCREENER = `https://dexscreener.com/robinhood/${ADDR.poolId}`;
const INITIAL_COAT_SUPPLY = 1_000_000_000; // 1B, fixed at launch

type Metrics = {
  minted?: number;
  active?: number;
  burned?: number;
  burnedPct?: number;
  priceUsd?: number;
  fdvUsd?: number;
  earnedUsd?: number;
  /** True when not a single read succeeded — the RPC, not the data, is what's missing. */
  unreachable: boolean;
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

async function loadMetrics(): Promise<Metrics> {
  const next: Metrics = { unreachable: true };

  try {
    const [minted, active, supply] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: ADDR.broker, abi: brokerAbi, functionName: "totalMinted" },
        { address: ADDR.booster, abi: boosterAbi, functionName: "activeShares" },
        { address: ADDR.coat, abi: coatAbi, functionName: "totalSupply" },
      ],
    });
    next.minted = Number(minted);
    next.active = Number(active);
    next.burned = INITIAL_COAT_SUPPLY - Number(formatUnits(supply, 18));
    next.burnedPct = (next.burned / INITIAL_COAT_SUPPLY) * 100;
    next.unreachable = false;
  } catch { /* leave undefined → renders "—" */ }

  // ETH/USD from the Booster's configured feed (no hardcoded address).
  let ethUsd = 0;
  try {
    const feed = await client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "ethUsdFeed" });
    if (feed && feed !== zeroAddress) {
      const [dec, rd] = await client.multicall({
        allowFailure: false,
        contracts: [
          { address: feed, abi: aggregatorAbi, functionName: "decimals" },
          { address: feed, abi: aggregatorAbi, functionName: "latestRoundData" },
        ],
      });
      ethUsd = Number(formatUnits(rd[1], Number(dec)));
      next.unreachable = false;
    }
  } catch { /* price stays undefined */ }

  // $COAT price = ETH/USD ÷ (COAT bought per 1 ETH).
  try {
    if (ADDR.router && ethUsd > 0) {
      const coatPerEth = await client.readContract({
        address: ADDR.router as `0x${string}`, abi: routerAbi, functionName: "quoteBuy", args: [10n ** 18n],
      });
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
  // keep counting or this figure silently shrinks. Three multicalls total, however
  // many tokens there are, instead of one round trip per field per token.
  try {
    const count = Number(await client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "knownTokenCount" }));
    const tokens = await client.multicall({
      allowFailure: false,
      contracts: Array.from({ length: count }, (_, i) => ({
        address: ADDR.booster, abi: boosterAbi, functionName: "knownTokens" as const, args: [BigInt(i)] as const,
      })),
    });
    const perToken = await client.multicall({
      allowFailure: true,
      contracts: tokens.flatMap((token) => [
        { address: ADDR.booster, abi: boosterAbi, functionName: "totalBought" as const, args: [token] as const },
        { address: ADDR.booster, abi: boosterAbi, functionName: "stockFeed" as const, args: [token] as const },
        { address: token, abi: erc20Abi, functionName: "decimals" as const },
      ]),
    });
    const rows = tokens.map((token, i) => ({
      token,
      bought: perToken[i * 3]?.result as bigint | undefined,
      feed: perToken[i * 3 + 1]?.result as `0x${string}` | undefined,
      dec: perToken[i * 3 + 2]?.result as number | undefined,
    })).filter((r) => r.bought !== undefined && r.dec !== undefined && r.feed && r.feed !== zeroAddress);
    const feedReads = await client.multicall({
      allowFailure: true,
      contracts: rows.flatMap((r) => [
        { address: r.feed!, abi: aggregatorAbi, functionName: "decimals" as const },
        { address: r.feed!, abi: aggregatorAbi, functionName: "latestRoundData" as const },
      ]),
    });
    let total = 0;
    rows.forEach((r, i) => {
      const fdec = feedReads[i * 2]?.result as number | undefined;
      const rd = feedReads[i * 2 + 1]?.result as readonly [bigint, bigint, bigint, bigint, bigint] | undefined;
      if (fdec === undefined || !rd) return;
      total += Number(formatUnits(r.bought!, r.dec!)) * Number(formatUnits(rd[1], fdec));
    });
    next.earnedUsd = total;
  } catch { /* earned stays undefined */ }

  return next;
}

export function HomeMetrics() {
  // Persisted across reloads and shared with react-query's retry/dedup: a refresh paints the
  // last known figures instantly, then revalidates in the background. Metrics move on the
  // keeper's hourly cadence; 2 min keeps the panel feeling live at a fraction of the load.
  const { data: m, isError } = useStoredQuery<Metrics>({
    storageKey: "home:metrics:v2",
    queryKey: ["home-metrics", ADDR.booster],
    queryFn: loadMetrics,
    staleTime: 90_000,
    refetchInterval: 120_000,
    ssrSafe: true,
    persistIf: (d) => !d.unreachable,
  });
  const loading = m === undefined;
  const unreachable = !loading && (m.unreachable || isError);

  // Everything paid to holders so far: the stock the engine bought for them, plus the
  // $COAT the treasury dropped into Broker wallets, both valued at today's prices.
  const coatDroppedUsd = m?.priceUsd !== undefined ? COAT_DROPPED_TOTAL * m.priceUsd : undefined;
  const paidUsd =
    m?.earnedUsd !== undefined && coatDroppedUsd !== undefined ? m.earnedUsd + coatDroppedUsd : undefined;
  const stats: { k: string; v: string; sub?: string }[] = [
    { k: "Brokers", v: m?.minted !== undefined ? `${m.minted.toLocaleString("en-US")} / 1,776` : "—" },
    { k: "Active & earning", v: m?.active !== undefined ? m.active.toLocaleString("en-US") : "—" },
    { k: "$COAT burned", v: m?.burned !== undefined ? `${compact(m.burned)}${m.burnedPct ? ` · ${m.burnedPct.toFixed(1)}%` : ""}` : "—" },
    { k: "Paid to holders", v: usd(paidUsd), sub: "stock + $COAT drops" },
    { k: "Stock distributed", v: usd(m?.earnedUsd) },
    { k: "$COAT dropped", v: usd(coatDroppedUsd), sub: `${compact(COAT_DROPPED_TOTAL)} COAT · ${COAT_DROPS.length} tranche${COAT_DROPS.length === 1 ? "" : "s"}` },
    { k: "$COAT price", v: usd(m?.priceUsd) },
    { k: "Fully-diluted value", v: usd(m?.fdvUsd) },
  ];

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="pixel-title text-[15px]">Live metrics</h2>
        <div className="flex flex-wrap gap-2">
          <a href={OPENSEA_URL} target="_blank" rel="noopener noreferrer" className="btn btn-ghost text-[12px] px-3 py-1.5">OpenSea ↗</a>
          <a href={LINKS.coatOnOpenSea} target="_blank" rel="noopener noreferrer" className="btn btn-ghost text-[12px] px-3 py-1.5">$COAT ↗</a>
          <a href={DEXSCREENER} target="_blank" rel="noopener noreferrer" className="btn btn-ghost text-[12px] px-3 py-1.5">DexScreener ↗</a>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" aria-busy={loading}>
        {stats.map((s) => (
          <div key={s.k} className="stat">
            <div className="text-[11px] text-ink-soft uppercase tracking-widest">{s.k}</div>
            {loading ? (
              <div className="skeleton h-5 w-24 mt-1.5" aria-hidden="true" />
            ) : (
              <div className="font-pixel text-base text-ink-strong mt-1 break-words">{s.v}</div>
            )}
            {s.sub && !loading && <div className="text-[11px] text-ink-soft mt-0.5">{s.sub}</div>}
          </div>
        ))}
      </div>
      {COAT_DROPS.length > 0 && (
        <p className="text-ink-soft text-[11px] mt-2">
          $COAT drops so far:{" "}
          {COAT_DROPS.map((d, i) => (
            <span key={d.block}>
              {i > 0 && " · "}
              <a href={d.receipts} target="_blank" rel="noopener noreferrer" className="underline hover:text-ink-strong">
                {d.label}
              </a>{" "}
              ({compact(d.coat)} COAT to {d.recipients.toLocaleString("en-US")} wallets, block {d.block.toLocaleString("en-US")})
            </span>
          ))}
        </p>
      )}
      <p className="text-ink-soft text-[11px] mt-3" role="status" aria-live="polite">
        {unreachable
          ? "Chain metrics are temporarily unavailable — the RPC is not answering. Nothing on-chain is affected; this panel retries on its own."
          : "Live from the chain · $COAT burned is removed from supply permanently · stock and $COAT are valued at today's on-chain prices."}
      </p>
    </section>
  );
}
