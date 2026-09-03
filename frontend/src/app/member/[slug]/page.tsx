"use client";

// One member of Congress, as the basket sees them: every filing in the basket window,
// how much they bought, how fast they file, which of their names the basket can buy,
// and the track-record multiplier the smart layer gives them. Public, no wallet.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Header } from "@/components/Header";

type Row = {
  symbol: string; type: "buy" | "sell" | "other"; amount: string; notional: number;
  traded: string; filed: string; lagDays: number | null; buyable: boolean; inBasket: boolean;
};
type Member = {
  slug: string; name: string; chamber: string; trades: number; buys: number; sells: number;
  buyNotional: number; sellNotional: number; buyableShare: number | null; medianLagDays: number | null;
  lastFiled: string; lastTraded: string;
  topTickers: { symbol: string; notional: number; buyable: boolean }[];
  score: { multiplier: number | null; avgExcess30d: number | null; trades: number | null } | null;
  rows: Row[];
};
type State = { status: "loading" } | { status: "missing" } | { status: "ready"; member: Member; windowDays: number };

const money = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${Math.round(n / 1_000)}K` : `$${Math.round(n)}`);

export default function MemberPage() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let stale = false;
    if (!slug) { setState({ status: "missing" }); return; }
    fetch(`/api/members/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        const j = await r.json();
        if (stale) return;
        if (!r.ok || !j.ok) setState({ status: "missing" });
        else setState({ status: "ready", member: j.member, windowDays: j.windowDays });
      })
      .catch(() => { if (!stale) setState({ status: "missing" }); });
    return () => { stale = true; };
  }, [slug]);

  const m = state.status === "ready" ? state.member : null;
  const chamber = m ? (m.chamber.includes("senat") ? "Senate" : "House") : "";

  return (
    <>
      <Header />
      <main className="mx-auto max-w-3xl px-6 py-10 grid gap-5">
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <Link href="/" className="text-[11px] text-ink-soft hover:text-ink-strong underline">← coattail.cash</Link>
            {state.status === "ready" && <span className="text-[11px] text-ink-soft">last {state.windowDays} days of filings</span>}
          </div>
          {state.status === "loading" && <p className="text-ink-soft text-sm">Reading filings…</p>}
          {state.status === "missing" && <p className="text-ink-soft text-sm">No filings for this member in the current window.</p>}
          {m && (
            <>
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <h1 className="font-pixel text-lg text-ink-strong">{m.name}</h1>
                <span className="badge">{chamber}</span>
                {m.score?.multiplier && (
                  <span className="badge border-accent text-accent" title="track-record multiplier the smart layer applies to this member's buys">
                    record x{m.score.multiplier.toFixed(2)}
                  </span>
                )}
              </div>
              <p className="text-ink-soft text-sm mb-4">
                What this member disclosed in the window the basket is built from, and how much of it a Broker could actually buy.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
                <div className="stat"><div className="text-[11px] text-ink-soft uppercase tracking-widest">Bought</div><div className="font-pixel text-[13px] text-ink-strong mt-1 tabular-nums">{money(m.buyNotional)}</div><div className="text-[10px] text-ink-soft">{m.buys} buys · {m.sells} sells</div></div>
                <div className="stat"><div className="text-[11px] text-ink-soft uppercase tracking-widest">Buyable</div><div className="font-pixel text-[13px] text-ink-strong mt-1 tabular-nums">{m.buyableShare !== null ? `${Math.round(m.buyableShare * 100)}%` : "—"}</div><div className="text-[10px] text-ink-soft">of buying dollars</div></div>
                <div className="stat"><div className="text-[11px] text-ink-soft uppercase tracking-widest">Files in</div><div className="font-pixel text-[13px] text-ink-strong mt-1 tabular-nums">{m.medianLagDays !== null ? `${m.medianLagDays}d` : "—"}</div><div className="text-[10px] text-ink-soft">median trade to filing</div></div>
                <div className="stat"><div className="text-[11px] text-ink-soft uppercase tracking-widest">Last filed</div><div className="font-pixel text-[13px] text-ink-strong mt-1 tabular-nums">{m.lastFiled || "—"}</div><div className="text-[10px] text-ink-soft">{m.score?.trades ? `${m.score.trades} trades scored` : ""}</div></div>
              </div>
              {m.topTickers.length > 0 && (
                <div className="mb-4">
                  <div className="label">Most bought</div>
                  <div className="flex flex-wrap gap-1.5">
                    {m.topTickers.map((t) => (
                      <span key={t.symbol} className={`badge ${t.buyable ? "" : "border-ink-soft text-ink-soft"}`}>{t.symbol} · {money(t.notional)}</span>
                    ))}
                  </div>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm min-w-[560px]">
                  <thead>
                    <tr className="text-left">
                      {["Ticker", "Action", "Amount", "Traded", "Filed"].map((h) => (
                        <th key={h} className="border-b-2 border-ink py-2 pr-3 font-pixel text-[10px] uppercase text-ink-soft">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {m.rows.map((r, i) => (
                      <tr key={`${r.symbol}-${r.traded}-${i}`} className="border-b border-line">
                        <td className="py-2 pr-3"><span className={`badge ${r.inBasket ? "border-accent text-accent" : r.buyable ? "" : "border-ink-soft text-ink-soft"}`}>{r.symbol}</span></td>
                        <td className="py-2 pr-3"><span className={r.type === "buy" ? "text-good" : r.type === "sell" ? "text-accent" : "text-ink-soft"}>{r.type === "buy" ? "▲ BUY" : r.type === "sell" ? "▼ SELL" : "—"}</span></td>
                        <td className="py-2 pr-3 text-ink-soft tabular-nums">{r.amount || "—"}</td>
                        <td className="py-2 pr-3 text-ink-soft tabular-nums">{r.traded || "—"}</td>
                        <td className="py-2 text-ink-soft tabular-nums">{r.filed || "—"}{typeof r.lagDays === "number" && r.lagDays >= 0 && <span className="text-[10px] ml-1">({r.lagDays}d)</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-ink-soft mt-3">
                Buyable = the stock is tokenized on Robinhood Chain with a funded pool and a Chainlink feed. Amounts are the STOCK Act ranges; dollar totals use range midpoints.
              </p>
            </>
          )}
        </div>
      </main>
    </>
  );
}
