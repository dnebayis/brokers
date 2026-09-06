"use client";

// The whole desk in charts: what the engine bought and when, how the basket has shifted,
// how many Brokers switched on and what that burned, and what Congress filed in the last
// month. Everything here is the same data the rest of the site runs on, drawn over time
// instead of quoted as a single number. Historical, never a forecast.

import { useMemo, useState } from "react";
import { BarChart, HBarChart, Legend, LineChart, StackedArea, SERIES_COLORS } from "@/components/charts/Charts";
import { useStats, type StatsPayload } from "@/lib/useStats";
import { COAT_DROPS, PARAMS } from "@/lib/config";

const DAY = 86_400;
const dayStart = (ts: number) => Math.floor(ts / DAY) * DAY;
const usd0 = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const usdK = (n: number) =>
  Math.abs(n) >= 1e6 ? "$" + (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + "M"
    : Math.abs(n) >= 1000 ? "$" + Math.round(n / 1000).toLocaleString("en-US") + "k"
      : "$" + Math.round(n);
const num = (n: number) => Math.round(n).toLocaleString("en-US");
const compact = (n: number) => n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`);
const tone = (n: number | null | undefined) => (n === null || n === undefined ? "text-ink-soft" : n >= 0 ? "text-good" : "text-accent");
const stamp = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

function Section({ eyebrow, title, blurb, asOf, children }: {
  eyebrow: string; title: string; blurb: React.ReactNode; asOf?: string; children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <p className="font-pixel text-[10px] tracking-widest text-ink-soft uppercase">{eyebrow}</p>
        {asOf && <span className="text-[11px] text-ink-soft">as of {asOf}</span>}
      </div>
      <h2 className="pixel-title text-[15px] mt-1">{title}</h2>
      <p className="text-ink-soft text-sm mt-1 mb-4 max-w-2xl">{blurb}</p>
      {children}
    </section>
  );
}

function ChartTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-2 mt-5 first:mt-0">
      <h3 className="font-pixel text-[11px] text-ink-strong">{children}</h3>
      {right && <span className="text-[11px] text-ink-soft">{right}</span>}
    </div>
  );
}

function Stat({ k, v, sub, cls }: { k: string; v: React.ReactNode; sub?: string; cls?: string }) {
  return (
    <div className="stat">
      <div className="text-[11px] text-ink-soft uppercase tracking-widest">{k}</div>
      <div className={`font-pixel text-base mt-1 break-words ${cls ?? "text-ink-strong"}`}>{v}</div>
      {sub && <div className="text-[11px] text-ink-soft mt-0.5">{sub}</div>}
    </div>
  );
}

function Unavailable({ what }: { what: string }) {
  return <p className="text-ink-soft text-sm">{what} could not be read just now. The rest of the page still charts.</p>;
}

/* ───────────── payroll: the engine's purchases ───────────── */

function Payroll({ sc }: { sc: NonNullable<StatsPayload["scorecard"]> }) {
  // "Now" is read once per mount so the memo stays pure; the tab remounts on every visit.
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const { cumulative, perDay, bySymbol } = useMemo(() => {
    const events = sc.events;
    const cumulative: { x: number; y: number }[] = [];
    let run = 0;
    for (const [, ts, usd] of events) { run += usd; cumulative.push({ x: ts, y: run }); }
    const days = new Map<number, number>();
    if (events.length) {
      const first = dayStart(events[0][1]), last = dayStart(Math.max(events[events.length - 1][1], now));
      for (let d = first; d <= last; d += DAY) days.set(d, 0);
      for (const [, ts] of events) days.set(dayStart(ts), (days.get(dayStart(ts)) ?? 0) + 1);
    }
    const perDay = [...days.entries()].map(([x, y]) => ({ x, y }));
    const bySymbol = new Map<string, number>();
    for (const [, , usd, si] of events) { const s = sc.symbols[si] ?? "?"; bySymbol.set(s, (bySymbol.get(s) ?? 0) + usd); }
    return { cumulative, perDay, bySymbol };
  }, [sc, now]);
  const names = [...sc.names].sort((a, b) => (b.usdSpent ?? 0) - (a.usdSpent ?? 0));
  const b = sc.benchmarks;
  const benchRows = b ? [
    { label: "basket", value: b.basket.pnlPct ?? 0, note: "what the engine actually bought" },
    { label: "SPY", value: b.spy.pnlPct ?? 0, note: "same dollars, same hours, into SPY" },
    { label: "smart", value: b.smart.pnlPct ?? 0, note: `shadow smart basket · ${b.smart.coveragePct?.toFixed(0) ?? "—"}% of purchases covered` },
    ...(b.smartCapped ? [{ label: "capped", value: b.smartCapped.pnlPct ?? 0, note: `capped smart basket · ${b.smartCapped.coveragePct?.toFixed(0) ?? "—"}% covered` }] : []),
  ].map((r) => ({ ...r, tone: r.value >= 0 ? "var(--c-good)" : "var(--c-accent)" })) : [];
  return (
    <Section eyebrow="payroll" title="What the engine bought." asOf={stamp(sc.generatedAt)}
      blurb={<>Every stock purchase the engine has made for active Brokers since launch, priced in dollars at the Chainlink ETH/USD round of that hour. Value is today&rsquo;s Chainlink price on the shares, assuming they are still held.</>}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
        <Stat k="purchases" v={num(sc.purchases)} />
        <Stat k="dollars deployed" v={usd0(sc.totals.usdSpent)} />
        <Stat k="worth today" v={usd0(sc.totals.value)} />
        <Stat k="unrealised" v={pct(sc.totals.pnlPct)} sub={usd0(sc.totals.pnlUsd)} cls={tone(sc.totals.pnlPct)} />
      </div>
      <ChartTitle>Dollars deployed, cumulative</ChartTitle>
      <LineChart series={[{ name: "deployed", points: cumulative }]} yFormat={usdK} area height={220} hint="cumulative dollars the engine has spent on stock" />
      <ChartTitle>Purchases per day</ChartTitle>
      <BarChart points={perDay} yFormat={num} height={150} hint="engine purchases per day" />
      <ChartTitle right="cost vs worth today">Where the dollars went</ChartTitle>
      <HBarChart rows={names.map((n) => ({ label: n.symbol, value: n.usdSpent ?? bySymbol.get(n.symbol) ?? 0, value2: n.value ?? 0, note: `${n.buys} buys · ${pct(n.pnlPct)}` }))}
        format={usd0} format2={usd0} hint="dollars spent per stock against its value today" />
      <Legend items={[{ name: "cost", color: "var(--c-ink)" }, { name: "worth today", color: "url(#hatch-accent)" }]} />
      <ChartTitle>Unrealised, per name</ChartTitle>
      <HBarChart rows={names.map((n) => ({ label: n.symbol, value: n.pnlPct ?? 0, tone: (n.pnlPct ?? 0) >= 0 ? "var(--c-good)" : "var(--c-accent)", note: `${usd0(n.pnlUsd ?? 0)}` }))}
        format={(v) => pct(v)} hint="unrealised gain or loss per stock in percent" />
      {benchRows.length > 0 && (
        <>
          <ChartTitle right="same dollars at the same hours">Against the benchmarks</ChartTitle>
          <HBarChart rows={benchRows} format={(v) => pct(v)} hint="basket return against SPY and the shadow baskets" />
          <p className="text-[11px] text-ink-soft mt-2">
            SPY is buy-and-hold of the same dollars at the same hours. The smart basket is a shadow the indexer runs alongside the live one; it only covers the hours where it had a basket of its own.
          </p>
        </>
      )}
    </Section>
  );
}

/* ───────────── basket over time ───────────── */

function Basket({ sh }: { sh: NonNullable<StatsPayload["shadow"]> }) {
  const { keys, rows, divergence } = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of sh.rows) for (const [t, bps] of r.live) totals.set(t, (totals.get(t) ?? 0) + bps);
    const keys = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const rows = sh.rows.map((r) => {
      const values: Record<string, number> = {};
      for (const [t, bps] of r.live) values[t] = bps / 10000;
      return { x: r.at, values };
    });
    const divergence = sh.rows.map((r) => ({ x: r.at, y: r.divergenceBps / 100 }));
    return { keys, rows, divergence };
  }, [sh]);
  const latest = sh.rows[sh.rows.length - 1];
  return (
    <Section eyebrow="the basket" title="How the basket has moved." asOf={latest ? stamp(new Date(latest.at * 1000).toISOString()) : undefined}
      blurb={<>The live basket at every indexer pass: which tokenized names carried what weight. Weights come from what members of Congress disclosed as buys, filtered to names that trade on Robinhood Chain.</>}>
      <ChartTitle right={`${sh.rows.length} passes`}>Live weights over time</ChartTitle>
      <StackedArea keys={keys} rows={rows} height={240} hint="basket weights per name over time" />
      <Legend items={keys.map((k, i) => ({ name: k, index: i }))} />
      <ChartTitle right="how far the shadow smart basket sits from the live one">Divergence, live vs smart</ChartTitle>
      <LineChart series={[{ name: "divergence", points: divergence, color: "var(--c-accent)" }]} yFormat={(v) => `${v.toFixed(0)}%`} height={150} hint="divergence between the live and shadow baskets in percent" />
      {latest && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-4">
          <div className="stat">
            <div className="text-[11px] text-ink-soft uppercase tracking-widest">live basket now</div>
            <div className="font-pixel text-[11px] text-ink-strong mt-1 leading-relaxed">
              {latest.live.map(([t, b]) => `${t} ${(b / 100).toFixed(0)}%`).join(" · ")}
            </div>
          </div>
          {latest.capped && (
            <div className="stat">
              <div className="text-[11px] text-ink-soft uppercase tracking-widest">shadow, capped smart</div>
              <div className="font-pixel text-[11px] text-ink-strong mt-1 leading-relaxed">
                {latest.capped.map(([t, b]) => `${t} ${(b / 100).toFixed(0)}%`).join(" · ")}
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

/* ───────────── activations & burn, straight from the chain ───────────── */

function Activations({ ac }: { ac: NonNullable<StatsPayload["activations"]> }) {
  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const series = useMemo(() => {
    const active: { x: number; y: number }[] = [];
    const burned: { x: number; y: number }[] = [];
    const perDay = new Map<number, number>();
    const state = new Map<number, boolean>();
    let a = 0, b = 0;
    const events = ac.events.filter((e) => e[1] > 0);
    if (events.length) for (let d = dayStart(events[0][1]); d <= dayStart(now); d += DAY) perDay.set(d, 0);
    for (const [, ts, id, on, burn] of events) {
      const was = state.get(id) ?? false;
      state.set(id, on === 1);
      if (on === 1 && !was) a += 1;
      if (on === 0 && was) a -= 1;
      b += burn;
      active.push({ x: ts, y: a });
      burned.push({ x: ts, y: b });
      if (on === 1) perDay.set(dayStart(ts), (perDay.get(dayStart(ts)) ?? 0) + 1);
    }
    if (active.length) { active.push({ x: now, y: a }); burned.push({ x: now, y: b }); }
    return { active, burned, perDay: [...perDay.entries()].map(([x, y]) => ({ x, y })) };
  }, [ac, now]);
  const t = ac.totals;
  return (
    <Section eyebrow="activations" title="Switched on, and what it burned." asOf={stamp(ac.generatedAt)}
      blurb={<>Read from the Broker contract&rsquo;s own Activated and Deactivated events. Every activation burns {PARAMS.activationBurn.toLocaleString("en-US")} $COAT; a transfer switches a Broker off and whoever holds it can switch it back on.</>}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
        <Stat k="active now" v={num(t.activeNow)} sub={`of ${PARAMS.maxSupply.toLocaleString("en-US")} Brokers`} />
        <Stat k="activations" v={num(t.activations)} sub={`${num(t.deactivations)} switched off`} />
        <Stat k="burned by activation" v={`${compact(t.burned)} $COAT`} />
        <Stat k="per activation" v={`${PARAMS.activationBurn.toLocaleString("en-US")} $COAT`} />
      </div>
      <ChartTitle>Active Brokers over time</ChartTitle>
      <LineChart series={[{ name: "active", points: series.active }]} yFormat={num} area height={200} hint="number of active Brokers over time" />
      <ChartTitle>$COAT burned by activations, cumulative</ChartTitle>
      <LineChart series={[{ name: "burned", points: series.burned, color: "var(--c-accent)" }]} yFormat={(v) => compact(v)} area height={180} hint="cumulative COAT burned by activations" />
      <ChartTitle>Activations per day</ChartTitle>
      <BarChart points={series.perDay} yFormat={num} height={150} hint="activations per day" />
    </Section>
  );
}

/* ───────────── congress, last 30 days ───────────── */

function Congress({ fe }: { fe: NonNullable<StatsPayload["feed"]> }) {
  const m = useMemo(() => {
    const rows = fe.rows;
    const byDay = new Map<number, { buy: number; sell: number }>();
    const notionalByDay = new Map<number, number>();
    for (const r of rows) {
      const t = Date.parse(r.filed + "T00:00:00Z") / 1000;
      if (!isFinite(t)) continue;
      const d = byDay.get(t) ?? { buy: 0, sell: 0 };
      if (r.type === "buy") d.buy++; else if (r.type === "sell") d.sell++;
      byDay.set(t, d);
      notionalByDay.set(t, (notionalByDay.get(t) ?? 0) + r.notional);
    }
    const days = [...byDay.keys()].sort((a, b) => a - b);
    const filedPerDay = days.map((x) => ({ x, y: (byDay.get(x)!.buy + byDay.get(x)!.sell) }));
    const buysLine = days.map((x) => ({ x, y: byDay.get(x)!.buy }));
    const sellsLine = days.map((x) => ({ x, y: byDay.get(x)!.sell }));
    const buys = rows.filter((r) => r.type === "buy"), sells = rows.filter((r) => r.type === "sell");
    const sum = (xs: typeof rows) => xs.reduce((a, r) => a + r.notional, 0);
    const chamber = (c: string) => rows.filter((r) => r.chamber.toLowerCase() === c);
    const byTicker = new Map<string, { buy: number; sell: number; buyable: boolean; inBasket: boolean }>();
    for (const r of rows) {
      const t = byTicker.get(r.symbol) ?? { buy: 0, sell: 0, buyable: r.buyable, inBasket: r.inBasket };
      if (r.type === "buy") t.buy += r.notional; else if (r.type === "sell") t.sell += r.notional;
      t.buyable = t.buyable || r.buyable; t.inBasket = t.inBasket || r.inBasket;
      byTicker.set(r.symbol, t);
    }
    const topBought = [...byTicker.entries()].filter(([, v]) => v.buy > 0).sort((a, b) => b[1].buy - a[1].buy).slice(0, 12);
    const lagBuckets: [string, (d: number) => boolean][] = [
      ["0-7d", (d) => d <= 7], ["8-14d", (d) => d > 7 && d <= 14], ["15-30d", (d) => d > 14 && d <= 30],
      ["31-45d", (d) => d > 30 && d <= 45], ["46d+", (d) => d > 45],
    ];
    const lags = rows.map((r) => r.lagDays).filter((d): d is number => d !== null);
    const lagRows = lagBuckets.map(([label, f]) => ({ label, value: lags.filter(f).length }));
    const buyableBuys = buys.filter((r) => r.buyable);
    return {
      filedPerDay, buysLine, sellsLine,
      buyCount: buys.length, sellCount: sells.length, buyNotional: sum(buys), sellNotional: sum(sells),
      house: chamber("house").length, senate: chamber("senate").length,
      topBought, lagRows, medianLag: lags.length ? [...lags].sort((a, b) => a - b)[Math.floor(lags.length / 2)] : null,
      buyableShare: buys.length ? buyableBuys.length / buys.length : null,
      buyableNotionalShare: sum(buys) ? sum(buyableBuys) / sum(buys) : null,
    };
  }, [fe]);
  return (
    <Section eyebrow={`congress · last ${fe.days} days`} title="What got filed." asOf={stamp(fe.generatedAt)}
      blurb={<>Every disclosure in the window, by the day it was filed. Notional is the midpoint of the range a member reports. &ldquo;Buyable&rdquo; means the name has a tokenized twin on Robinhood Chain, which is what lets it into the basket.</>}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
        <Stat k="buys" v={num(m.buyCount)} sub={`${usdK(m.buyNotional)} notional`} />
        <Stat k="sells" v={num(m.sellCount)} sub={`${usdK(m.sellNotional)} notional`} />
        <Stat k="house / senate" v={`${m.house} / ${m.senate}`} sub="filings" />
        <Stat k="buys we can mirror" v={m.buyableShare === null ? "—" : `${Math.round(m.buyableShare * 100)}%`}
          sub={m.buyableNotionalShare === null ? undefined : `${Math.round(m.buyableNotionalShare * 100)}% of buy dollars`} />
      </div>
      <ChartTitle>Filings per day, buys vs sells</ChartTitle>
      <LineChart series={[{ name: "buys", points: m.buysLine, color: "var(--c-good)" }, { name: "sells", points: m.sellsLine, color: "var(--c-accent)" }]}
        yFormat={num} height={180} hint="filings per day split into buys and sells" />
      <Legend items={[{ name: "buys", color: "var(--c-good)" }, { name: "sells", color: "var(--c-accent)" }]} />
      <ChartTitle right="ink: buyable on chain · hatched: no tokenized twin">Most bought, by notional</ChartTitle>
      <HBarChart rows={m.topBought.map(([sym, v]) => ({ label: sym, value: v.buy, tone: v.buyable ? (v.inBasket ? "var(--c-accent)" : "var(--c-ink)") : "url(#hatch-ink)", note: v.inBasket ? "in the basket now" : v.buyable ? "buyable" : "not tokenized" }))}
        format={usdK} hint="most bought names by reported notional" />
      <Legend items={[{ name: "in the basket now", color: "var(--c-accent)" }, { name: "buyable", color: "var(--c-ink)" }, { name: "not tokenized", color: "url(#hatch-ink)" }]} />
      <ChartTitle right={m.medianLag === null ? undefined : `median ${m.medianLag} days`}>Trade to filing lag</ChartTitle>
      <HBarChart rows={m.lagRows} format={num} hint="how many days between a trade and its filing" />
    </Section>
  );
}

/* ───────────── members ───────────── */

function Members({ me }: { me: NonNullable<StatsPayload["members"]> }) {
  const top = [...me.members].sort((a, b) => b.buyNotional - a.buyNotional).slice(0, 12);
  const house = me.members.filter((m) => m.chamber === "house").length;
  return (
    <Section eyebrow={`members · ${me.windowDays}-day window`} title="Who is buying." asOf={stamp(me.generatedAt)}
      blurb={<>Members with filings in the basket window, ranked by reported buy notional. Ink is buying, hatched is selling. The share of a member&rsquo;s buys we can actually mirror on chain is what decides how much of their filing reaches the basket.</>}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
        <Stat k="members tracked" v={num(me.members.length)} sub={`${house} house · ${me.members.length - house} senate`} />
        <Stat k="buy notional" v={usdK(me.members.reduce((a, m) => a + m.buyNotional, 0))} />
        <Stat k="sell notional" v={usdK(me.members.reduce((a, m) => a + m.sellNotional, 0))} />
        <Stat k="filings" v={num(me.members.reduce((a, m) => a + m.buys + m.sells, 0))} />
      </div>
      <ChartTitle right="buys / sells">Largest buyers</ChartTitle>
      <HBarChart labelWidth={118} rows={top.map((m) => ({
        label: m.name.length > 18 ? m.name.slice(0, 17) + "…" : m.name, value: m.buyNotional, value2: m.sellNotional,
        note: `${m.buys} buys · ${m.sells} sells · ${m.buyableShare === null ? "—" : Math.round(m.buyableShare * 100) + "% buyable"}${m.medianLagDays === null ? "" : ` · ${m.medianLagDays}d lag`}`,
      }))} format={usdK} format2={usdK} hint="members by reported buy notional" />
    </Section>
  );
}

/* ───────────── holder payouts, from the ledger ───────────── */

function Drops() {
  if (COAT_DROPS.length === 0) return null;
  const totalCoat = COAT_DROPS.reduce((a, d) => a + d.coat, 0);
  const totalUsd = COAT_DROPS.reduce((a, d) => a + d.usdAtDrop, 0);
  return (
    <Section eyebrow="$COAT paid to holders" title="Treasury drops."
      blurb={<>Each drop, with the dollar value at the hour it was paid. Receipts are one transaction per Broker.</>}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-4">
        <Stat k="drops" v={num(COAT_DROPS.length)} />
        <Stat k="$COAT dropped" v={compact(totalCoat)} />
        <Stat k="worth when paid" v={usd0(totalUsd)} />
        <Stat k="brokers paid" v={num(COAT_DROPS.reduce((a, d) => a + d.recipients, 0))} sub="seats, across drops" />
      </div>
      <HBarChart rows={COAT_DROPS.map((d) => ({ label: d.label, value: d.coat, note: `${d.recipients} Brokers · ${usd0(d.usdAtDrop)} when paid` }))}
        format={compact} hint="COAT per drop" labelWidth={90} />
    </Section>
  );
}

/* ───────────── the data set ───────────── */

function DataSet() {
  const raw = "https://raw.githubusercontent.com/dnebayis/brokers/data";
  const files = [
    { name: "basket-scorecard.json", what: "every engine purchase: block, tx, ETH in, shares, ETH/USD at that round, SPY price and shadow-basket prices at that hour; per-name and benchmark totals" },
    { name: "shadow-history.jsonl", what: "one row per indexer pass: live weights, shadow smart and capped baskets, vetoed names, divergence" },
    { name: "basket-latest.json", what: "the current basket with attribution: who bought each name, what was left out and why, route pre-flight" },
    { name: "feed-30d.json", what: "every disclosure in the last 30 days with member, chamber, range, lag, buyable and in-basket flags" },
    { name: "activations.json", what: "every Broker switched on or off since launch with its block, time and the $COAT that switch-on burned" },
    { name: "members.json", what: "per-member summary over the basket window: buys, sells, notional, buyable share, median lag, score" },
  ];
  const api = [
    { path: "/api/stats", what: "everything this tab draws, in one compact bundle" },
    { path: "/api/scorecard", what: "the scorecard summary without the event list" },
    { path: "/api/basket", what: "the current basket report" },
    { path: "/api/feed", what: "the disclosure feed" },
    { path: "/api/broker/{id}", what: "one Broker: owner, wallet, active, holdings, claimable" },
    { path: "/api/wallet/{address}/brokers", what: "every Broker a wallet holds" },
  ];
  return (
    <Section eyebrow="the data set" title="Take the whole thing."
      blurb={<>Every chart above is drawn from files the indexer publishes on every pass, plus the contracts&rsquo; own events. The files are public and the API is open, no key.</>}>
      <ChartTitle>Published files</ChartTitle>
      <ul className="divide-y divide-line border border-line">
        {files.map((f) => (
          <li key={f.name} className="px-3 py-2 flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4">
            <a className="font-pixel text-[11px] text-ink-strong underline shrink-0" href={`${raw}/${f.name}`} target="_blank" rel="noreferrer">{f.name}</a>
            <span className="text-ink-soft text-sm">{f.what}</span>
          </li>
        ))}
      </ul>
      <ChartTitle>Open API</ChartTitle>
      <ul className="divide-y divide-line border border-line">
        {api.map((a) => (
          <li key={a.path} className="px-3 py-2 flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4">
            <a className="font-pixel text-[11px] text-ink-strong underline shrink-0" href={a.path.includes("{") ? "#docs" : a.path} target={a.path.includes("{") ? undefined : "_blank"} rel="noreferrer">{a.path}</a>
            <span className="text-ink-soft text-sm">{a.what}</span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-ink-soft mt-3">
        Contracts, events and the indexer itself are in the{" "}
        <a className="underline" href="https://github.com/dnebayis/brokers" target="_blank" rel="noreferrer">public repository</a>. Check the chain.
      </p>
    </Section>
  );
}

export function StatsTab() {
  const { data, isLoading, isError } = useStats();
  return (
    <div className="max-w-3xl">
      <p className="font-pixel text-[11px] tracking-widest text-ink-soft">THE NUMBERS</p>
      <h1 className="font-pixel text-ink-strong text-[22px] sm:text-[26px] leading-snug mt-3">
        The whole desk, over time.
      </h1>
      <p className="text-lg text-ink-strong leading-relaxed mt-4">
        Home gives you today&rsquo;s numbers. This is the same data as a line: what the engine bought and when,
        how the basket shifted, who switched on, what Congress filed. Read from the chain and the indexer&rsquo;s
        published files, nothing hand-entered.
      </p>
      <div className="grid gap-6 mt-8">
        {isLoading && !data && <p className="text-ink-soft text-sm">Reading the data set…</p>}
        {isError && !data && <Unavailable what="The indexer's data" />}
        {data?.scorecard ? <Payroll sc={data.scorecard} /> : data && <Unavailable what="The scorecard" />}
        {data?.activations ? <Activations ac={data.activations} /> : data && <Unavailable what="The activation history" />}
        {data?.shadow ? <Basket sh={data.shadow} /> : data && <Unavailable what="The basket history" />}
        {data?.feed ? <Congress fe={data.feed} /> : data && <Unavailable what="The disclosure feed" />}
        {data?.members ? <Members me={data.members} /> : data && <Unavailable what="The members file" />}
        <Drops />
        <DataSet />
      </div>
      <p className="text-[11px] text-ink-soft mt-6">
        Colours: <span style={{ color: SERIES_COLORS[0] }}>ink</span> is the live thing, <span style={{ color: SERIES_COLORS[1] }}>brick</span> is a comparison or a cost, green is up, brick is down. Every axis is what it says.
      </p>
    </div>
  );
}
