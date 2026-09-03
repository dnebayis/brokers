"use client";

import { useStoredQuery } from "@/lib/useStoredQuery";

// "The basket right now": the live weights next to the filings that produced them. Every
// line is a disclosed trade (member, amount range, dates) from the same rows the indexer
// aggregates, so a holder can see whose buys their Broker is following. The note at the
// bottom is written by a model from exactly these facts and is labelled as such.

type Buyer = {
  member: string; chamber: string; buys: number; notionalUsd: number;
  latestTraded: string; latestFiled: string; ranges: string[];
};
type Attribution = Record<string, { buyers: Buyer[]; buyerCount: number; sellCount: number }>;
type Basket = {
  ok: boolean;
  generatedAt: string;
  coverage: number;
  tickers: string[];
  weightsBps: number[];
  attribution?: Attribution;
  missedCoverage?: { ticker: string; netNotional: number; shareOfBuying: number }[];
  missedAttribution?: Attribution;
  commentary?: { text: string; model: string; generatedAt: string } | null;
};

async function fetchBasket(): Promise<Basket> {
  const res = await fetch("/api/basket");
  const payload = (await res.json()) as Basket;
  if (!res.ok) throw new Error("basket unavailable");
  return payload;
}

const money = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${Math.round(n / 1_000)}K` : `$${Math.round(n)}`;
const shortRange = (r: string) =>
  r.replace(/\$([\d,]+) - \$([\d,]+)/, (_, a, b) => `$${compact(a)}–$${compact(b)}`);
const compact = (s: string) => {
  const n = Number(s.replace(/,/g, ""));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
};
const day = (d: string) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "");
const chamber = (c: string) => (c.includes("senat") ? "Senate" : c ? "House" : "");

export function BasketNow() {
  const { data, isLoading, isError } = useStoredQuery<Basket>({
    storageKey: "coattail.basket.v1",
    queryKey: ["basket-now"],
    queryFn: fetchBasket,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    persistIf: (d) => d.ok && Array.isArray(d.tickers),
  });
  if (isError && !data) return null;
  const rows = data
    ? data.tickers.map((t, i) => ({ ticker: t, bps: data.weightsBps[i], info: data.attribution?.[t] }))
    : [];
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-1">
        <h2 className="pixel-title text-[15px]">The basket right now</h2>
        {data && (
          <span className="text-[11px] text-ink-soft">
            as of {new Date(data.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
      <p className="text-ink-soft text-sm mb-4">
        What every active Broker is buying, and whose disclosed trades put each name there. Weights come
        from 90 days of filings, net of selling, capped at 50% per name.
      </p>
      {isLoading && !data && <p className="text-ink-soft text-sm">Reading the latest basket…</p>}
      {rows.length > 0 && (
        <div className="grid gap-3">
          {rows.map(({ ticker, bps, info }) => (
            <div key={ticker} className="border border-line bg-cream p-3">
              <div className="flex items-center gap-3 mb-1.5">
                <span className="badge">{ticker}</span>
                <div className="flex-1 h-2 bg-cream-3 border border-line">
                  <div className="h-full bg-accent" style={{ width: `${Math.max(2, bps / 100)}%` }} />
                </div>
                <span className="font-pixel text-[12px] text-ink-strong tabular-nums w-14 text-right">{(bps / 100).toFixed(1)}%</span>
              </div>
              {info && info.buyers.length > 0 ? (
                <ul className="grid gap-1 text-[13px]">
                  {info.buyers.slice(0, 3).map((b) => (
                    <li key={b.member} className="flex flex-wrap gap-x-2 gap-y-0.5">
                      <span className="text-ink-strong">{b.member}</span>
                      {chamber(b.chamber) && <span className="text-[10px] text-ink-soft uppercase self-center">{chamber(b.chamber)}</span>}
                      <span className="text-ink-soft tabular-nums">
                        {b.ranges[0] ? shortRange(b.ranges[0]) : money(b.notionalUsd)}
                        {b.buys > 1 ? ` · ${b.buys} buys (≈${money(b.notionalUsd)})` : ""}
                      </span>
                      <span className="text-ink-soft tabular-nums">
                        traded {day(b.latestTraded)}{b.latestFiled ? `, filed ${day(b.latestFiled)}` : ""}
                      </span>
                    </li>
                  ))}
                  {info.buyerCount > 3 && (
                    <li className="text-[12px] text-ink-soft">+{info.buyerCount - 3} more member{info.buyerCount - 3 > 1 ? "s" : ""} bought it</li>
                  )}
                  {info.sellCount > 0 && (
                    <li className="text-[12px] text-ink-soft">{info.sellCount} disclosed sale{info.sellCount > 1 ? "s" : ""} netted against these buys</li>
                  )}
                </ul>
              ) : (
                <p className="text-[12px] text-ink-soft">Carried by earlier filings in the window.</p>
              )}
            </div>
          ))}
        </div>
      )}
      {data && data.missedCoverage && data.missedCoverage.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="label">Left on the table</div>
          <p className="text-[12px] text-ink-soft mb-2">
            Big disclosed buys the basket cannot follow yet, because the stock is not tokenized or not tradable on this chain.
            Only {Math.round((data.coverage ?? 0) * 100)}% of the window&rsquo;s buying dollars could be bought.
          </p>
          <ul className="grid gap-1 text-[13px]">
            {data.missedCoverage.slice(0, 3).map((m) => {
              const who = data.missedAttribution?.[m.ticker]?.buyers?.[0]?.member;
              return (
                <li key={m.ticker} className="flex flex-wrap gap-x-2">
                  <span className="badge border-ink-soft text-ink-soft">{m.ticker}</span>
                  <span className="text-ink-soft tabular-nums">≈{money(m.netNotional)} net buying · {Math.round(m.shareOfBuying * 100)}% of all buying</span>
                  {who && <span className="text-ink-strong">{who}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {data?.commentary?.text && (
        <div className="mt-4 border-2 border-ink bg-cream-2 p-3 shadow-pixel-sm">
          <div className="flex items-center justify-between mb-1.5">
            <span className="font-pixel text-[10px] text-accent">AI NOTE</span>
            <span className="text-[10px] text-ink-soft">written from the filings above · not advice</span>
          </div>
          <p className="text-sm text-ink-strong leading-relaxed">{data.commentary.text}</p>
          <p className="text-[10px] text-ink-soft mt-2">{data.commentary.model} · regenerated only when the basket changes</p>
        </div>
      )}
    </div>
  );
}
