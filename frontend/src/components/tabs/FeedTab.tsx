"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useStoredQuery } from "@/lib/useStoredQuery";
import { BasketNow } from "@/components/BasketNow";
import { BasketScorecard } from "@/components/BasketScorecard";
import type { FeedItem } from "@/app/api/feed/route";

type FeedResult = {
  live: boolean;
  source: "indexer" | "unusual_whales" | "fmp" | "none";
  status: "ok" | "unconfigured" | "upstream_error" | "empty";
  days?: number;
  generatedAt?: string;
  items: FeedItem[];
};

type MemberSummary = {
  slug: string; name: string; chamber: string; trades: number; buys: number; sells: number;
  buyNotional: number; buyableShare: number | null; medianLagDays: number | null; lastFiled: string;
  topTickers: { symbol: string; notional: number; buyable: boolean }[];
  score: { multiplier: number | null } | null;
};

async function fetchFeed(): Promise<FeedResult> {
  const res = await fetch("/api/feed");
  return (await res.json()) as FeedResult;
}
async function fetchTopMembers(): Promise<{ ok: boolean; members: MemberSummary[] }> {
  const res = await fetch("/api/members?top=8");
  const payload = await res.json();
  if (!res.ok) throw new Error("members unavailable");
  return payload;
}

const money = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${Math.round(n / 1_000)}K` : `$${Math.round(n)}`);
const PAGE = 100;

export function FeedTab() {
  // Persisted across reloads; the export refreshes every indexer pass, so ten minutes of
  // staleness is the most a visitor can see.
  const { data, isLoading, isError } = useStoredQuery<FeedResult>({
    storageKey: "coattail.feed.v2",
    queryKey: ["congress-feed"],
    queryFn: fetchFeed,
    staleTime: 10 * 60_000,
    persistIf: (d) => d.status === "ok",
  });
  const top = useStoredQuery<{ ok: boolean; members: MemberSummary[] }>({
    storageKey: "coattail.members.top.v1",
    queryKey: ["top-members"],
    queryFn: fetchTopMembers,
    staleTime: 10 * 60_000,
    persistIf: (d) => d.ok,
  });

  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "buy" | "sell">("all");
  const [buyableOnly, setBuyableOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.items ?? []).filter((it) => {
      if (kind !== "all" && it.type !== kind) return false;
      if (buyableOnly && !it.buyable) return false;
      if (!needle) return true;
      return it.member.toLowerCase().includes(needle) || it.symbol.toLowerCase().includes(needle);
    });
  }, [data, q, kind, buyableOnly]);

  const isExport = data?.source === "indexer";

  return (
    <div className="grid gap-5">
    <BasketNow />
    <BasketScorecard />

    {top.data && top.data.members.length > 0 && (
      <div className="card">
        <h2 className="pixel-title text-[15px] mb-1">Who is buying the most</h2>
        <p className="text-ink-soft text-sm mb-3">Members ranked by disclosed buying in the basket window. Open one for their full record.</p>
        <div className="grid sm:grid-cols-2 gap-2">
          {top.data.members.map((m) => (
            <Link key={m.slug} href={`/member/${m.slug}`} className="border border-line bg-cream p-2.5 hover:border-ink transition-colors block">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink-strong text-sm">{m.name}</span>
                <span className="text-[10px] text-ink-soft uppercase">{m.chamber.includes("senat") ? "Senate" : "House"}</span>
              </div>
              <div className="text-[12px] text-ink-soft mt-0.5 tabular-nums">
                {money(m.buyNotional)} bought · {m.buys} buy{m.buys === 1 ? "" : "s"}
                {m.buyableShare !== null ? ` · ${Math.round(m.buyableShare * 100)}% buyable` : ""}
                {m.score?.multiplier ? ` · record x${m.score.multiplier.toFixed(2)}` : ""}
              </div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {m.topTickers.slice(0, 4).map((t) => (
                  <span key={t.symbol} className={`badge text-[9px] ${t.buyable ? "" : "border-ink-soft text-ink-soft"}`}>{t.symbol}</span>
                ))}
              </div>
            </Link>
          ))}
        </div>
      </div>
    )}

    <div className="card">
      <div className="flex items-center justify-between mb-1">
        <h2 className="pixel-title text-[15px]">Congress disclosures{isExport ? `, last ${data?.days ?? 30} days` : ""}</h2>
        {data && (
          <span className={`badge ${data.live ? "border-good text-good" : "border-ink-soft text-ink-soft"}`}>
            {data.live ? "LIVE" : "OFFLINE"}
          </span>
        )}
      </div>
      <p className="text-ink-soft text-sm mb-3">
        Every STOCK Act filing the basket is built from. Disclosures lag up to ~45 days; this is what was{" "}
        <i>filed</i>. Names marked <span className="badge text-[9px] align-middle">buyable</span> can enter the basket;{" "}
        <span className="badge text-[9px] align-middle border-accent text-accent">in basket</span> is in it right now.
      </p>

      {isExport && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input
            className="fld font-pixel text-[11px] max-w-[260px]"
            placeholder="member or ticker…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }}
            aria-label="Search filings by member or ticker"
          />
          {(["all", "buy", "sell"] as const).map((k) => (
            <button key={k} type="button" onClick={() => { setKind(k); setLimit(PAGE); }}
              className={`font-pixel text-[10px] px-2.5 py-2 border ${kind === k ? "border-ink text-ink-strong bg-cream" : "border-line text-ink-soft hover:text-ink-strong"}`}>
              {k === "all" ? "ALL" : k === "buy" ? "BUYS" : "SELLS"}
            </button>
          ))}
          <label className="flex items-center gap-1.5 text-[11px] text-ink-soft cursor-pointer select-none ml-1">
            <input type="checkbox" checked={buyableOnly} onChange={(e) => { setBuyableOnly(e.target.checked); setLimit(PAGE); }} className="accent-[var(--c-accent)]" />
            buyable only
          </label>
          <span className="text-[11px] text-ink-soft ml-auto tabular-nums">{items.length} filings</span>
        </div>
      )}

      {isLoading && !data && <p className="text-ink-soft text-sm">Loading disclosures…</p>}
      {isError && !data && <p className="text-accent text-sm">Feed unavailable right now.</p>}
      {data && !data.live && (
        <p className="text-accent text-sm mb-3">
          {data.status === "unconfigured" ? "Congress data source is not configured."
            : data.status === "upstream_error" ? "The configured Congress data provider rejected or failed the request."
            : "The provider returned no disclosures."}
        </p>
      )}

      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[640px]">
            <thead>
              <tr className="text-left">
                {["Member", "Ticker", "Action", "Amount", "Traded", "Filed"].map((h) => (
                  <th key={h} className="border-b-2 border-ink py-2 pr-3 font-pixel text-[10px] uppercase text-ink-soft">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.slice(0, limit).map((it, i) => (
                <tr key={`${it.slug ?? it.member}-${it.symbol}-${it.transactionDate}-${i}`} className="border-b border-line">
                  <td className="py-2 pr-3">
                    {it.slug ? (
                      <Link href={`/member/${it.slug}`} className="text-ink-strong hover:text-accent underline decoration-line underline-offset-2">{it.member}</Link>
                    ) : <span className="text-ink-strong">{it.member}</span>}
                    <span className="ml-2 text-[10px] text-ink-soft uppercase">{it.chamber}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`badge ${it.inBasket ? "border-accent text-accent" : it.buyable ? "" : "border-ink-soft text-ink-soft"}`}>{it.symbol}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={it.type === "buy" ? "text-good" : it.type === "sell" ? "text-accent" : "text-ink-soft"}>
                      {it.type === "buy" ? "▲ BUY" : it.type === "sell" ? "▼ SELL" : "—"}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-ink-soft tabular-nums">{it.amount || "—"}</td>
                  <td className="py-2 pr-3 text-ink-soft tabular-nums">{it.transactionDate || "—"}</td>
                  <td className="py-2 text-ink-soft tabular-nums">
                    {it.disclosureDate || "—"}
                    {typeof it.lagDays === "number" && it.lagDays >= 0 && <span className="text-[10px] ml-1">({it.lagDays}d)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length > limit && (
            <button type="button" className="btn btn-ghost w-full mt-3" onClick={() => setLimit((n) => n + PAGE)}>
              Show {Math.min(PAGE, items.length - limit)} more
            </button>
          )}
        </div>
      )}
      <p className="text-ink-soft text-xs mt-3">
        Cached in your browser · refreshes every indexer pass
        {data?.source && data.source !== "none" ? ` · source: ${data.source === "indexer" ? "indexer export (Unusual Whales)" : data.source.replace("_", " ")}` : ""}.
      </p>
    </div>
    </div>
  );
}
