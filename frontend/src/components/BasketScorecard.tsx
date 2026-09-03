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
type Scorecard = {
  ok: boolean; generatedAt: string; purchases: number;
  names: Name[];
  totals: { usdSpent: number; value: number; pnlUsd: number; pnlPct: number | null };
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
