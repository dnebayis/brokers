"use client";

import { useStoredQuery } from "@/lib/useStoredQuery";

// Which basket names made or lost money for holders: every engine purchase priced at
// its moment (Chainlink ETH/USD round) against the same stock's Chainlink price now.
// Nothing here is a forecast; it is the ledger of what was bought, at what cost, and
// where it trades today, assuming the shares are still held.

type Name = {
  symbol: string; buys: number; shares: number; usdSpent: number | null; avgCost: number | null;
  price: number | null; value: number | null; pnlUsd: number | null; pnlPct: number | null; firstBuy: number;
};
type Bench = { spent: number; value: number; pnlPct: number | null; purchases?: number; coveragePct?: number | null };
type Scorecard = {
  ok: boolean; generatedAt: string; purchases: number;
  names: Name[];
  totals: { usdSpent: number; value: number; pnlUsd: number; pnlPct: number | null };
  benchmarks?: { basket: Bench; spy: Bench; smart: Bench; smartCapped?: Bench; note?: string };
};

async function fetchScorecard(): Promise<Scorecard> {
  const res = await fetch("/api/scorecard");
  const payload = (await res.json()) as Scorecard;
  if (!res.ok) throw new Error("scorecard unavailable");
  return payload;
}

const usd = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits });
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`);
const tone = (n: number | null | undefined) => (n === null || n === undefined ? "text-ink-soft" : n >= 0 ? "text-good" : "text-accent");
const day = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function BasketScorecard() {
  const { data, isLoading, isError } = useStoredQuery<Scorecard>({
    storageKey: "coattail.scorecard.v1",
    queryKey: ["basket-scorecard"],
    queryFn: fetchScorecard,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    persistIf: (d) => d.ok && Array.isArray(d.names),
  });
  if (isError && !data) return null;
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-1">
        <h2 className="pixel-title text-[15px]">Scorecard</h2>
        {data && <span className="text-[11px] text-ink-soft">{data.purchases} engine purchases · as of {new Date(data.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}
      </div>
      <p className="text-ink-soft text-sm mb-4">
        Every stock the engine has bought since launch, at what it paid, against today&rsquo;s price.
        Cost is the ETH spent at that hour&rsquo;s Chainlink ETH/USD; today is the stock&rsquo;s Chainlink feed.
        Assumes the shares are still held. Historical, not a forecast.
      </p>
      {isLoading && !data && <p className="text-ink-soft text-sm">Reading purchases…</p>}
      {data && (
        <>
          <div className="grid grid-cols-3 gap-2.5 mb-4">
            <div className="stat">
              <div className="text-[11px] text-ink-soft uppercase tracking-widest">Bought at</div>
              <div className="font-pixel text-[13px] text-ink-strong mt-1 tabular-nums">{usd(data.totals.usdSpent, 0)}</div>
            </div>
            <div className="stat">
              <div className="text-[11px] text-ink-soft uppercase tracking-widest">Worth now</div>
              <div className="font-pixel text-[13px] text-ink-strong mt-1 tabular-nums">{usd(data.totals.value, 0)}</div>
            </div>
            <div className="stat">
              <div className="text-[11px] text-ink-soft uppercase tracking-widest">Gain / loss</div>
              <div className={`font-pixel text-[13px] mt-1 tabular-nums ${tone(data.totals.pnlUsd)}`}>
                {usd(data.totals.pnlUsd, 0)} <span className="text-[10px]">({pct(data.totals.pnlPct)})</span>
              </div>
            </div>
          </div>
          {data.benchmarks && (
            <div className="mb-4 border border-line bg-cream p-3">
              <div className="label">Same dollars, same hours</div>
              <div className={`grid gap-2 text-center ${data.benchmarks.smartCapped ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
                {([
                  ["This basket", data.benchmarks.basket, "what the engine actually bought"],
                  ["SPY instead", data.benchmarks.spy, "every purchase put into SPY that hour"],
                  ["Smart basket", data.benchmarks.smart, "the shadow layer's picks, priced leg by leg"],
                  ...(data.benchmarks.smartCapped
                    ? ([["Smart, capped", data.benchmarks.smartCapped, "no name above half, the rest to the live names"]] as const)
                    : []),
                ] as const).map(([label, b, sub]) => (
                  <div key={label}>
                    <div className="text-[10px] text-ink-soft uppercase tracking-widest">{label}</div>
                    <div className={`font-pixel text-[14px] mt-1 tabular-nums ${tone(b.pnlPct)}`}>{pct(b.pnlPct)}</div>
                    <div className="text-[10px] text-ink-soft mt-0.5">{sub}{b.coveragePct !== undefined && b.coveragePct !== null && b.coveragePct < 99.5 ? ` · ${Math.round(b.coveragePct)}% of dollars` : ""}</div>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-ink-soft mt-2">
                Each purchase is re-priced at its own hour from the Chainlink feeds, then marked at today&rsquo;s price. The smart basket only exists since its shadow series began, so it covers fewer dollars.
              </p>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm min-w-[620px]">
              <thead>
                <tr className="text-left">
                  {["Name", "Bought", "Avg cost", "Now", "Gain / loss", "Since"].map((h) => (
                    <th key={h} className="border-b-2 border-ink py-2 pr-3 font-pixel text-[10px] uppercase text-ink-soft">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.names.map((n) => (
                  <tr key={n.symbol} className="border-b border-line">
                    <td className="py-2 pr-3"><span className="badge">{n.symbol}</span></td>
                    <td className="py-2 pr-3 tabular-nums text-ink-soft">{usd(n.usdSpent, 0)} <span className="text-[10px]">· {n.buys} buys</span></td>
                    <td className="py-2 pr-3 tabular-nums">{usd(n.avgCost)}</td>
                    <td className="py-2 pr-3 tabular-nums">{usd(n.price)}</td>
                    <td className={`py-2 pr-3 tabular-nums ${tone(n.pnlUsd)}`}>{usd(n.pnlUsd)} <span className="text-[11px]">({pct(n.pnlPct)})</span></td>
                    <td className="py-2 tabular-nums text-ink-soft">{day(n.firstBuy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
