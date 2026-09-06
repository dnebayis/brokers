import { NextResponse } from "next/server";

// One payload for the Stats tab. The indexer publishes four files to the repository's
// `data` branch every pass; this route pulls them together, drops what a chart never needs
// (the vetoed-ticker lists, the model note, per-event tx hashes) and hands the browser a
// compact bundle cached for five minutes at the edge. Each part is independent: if one
// upstream file is unreachable its key is simply absent and the tab says so for that
// section instead of failing whole.
export const revalidate = 300;

const RAW = "https://raw.githubusercontent.com/dnebayis/brokers/data";
const URLS = {
  scorecard: process.env.SCORECARD_DATA_URL || `${RAW}/basket-scorecard.json`,
  shadow: process.env.SHADOW_HISTORY_URL || `${RAW}/shadow-history.jsonl`,
  feed: process.env.FEED_DATA_URL || `${RAW}/feed-30d.json`,
  members: process.env.MEMBERS_DATA_URL || `${RAW}/members.json`,
  activations: process.env.ACTIVATIONS_DATA_URL || `${RAW}/activations.json`,
};

export type StatsEvent = [block: number, ts: number, usdIn: number, symbolIndex: number];
export type StatsName = {
  symbol: string; buys: number; shares: number; usdSpent: number | null; avgCost: number | null;
  price: number | null; value: number | null; pnlUsd: number | null; pnlPct: number | null;
  firstBuy: number; lastBuy: number;
};
export type StatsBench = { spent: number; value: number; pnlPct: number | null; purchases?: number; coveragePct?: number | null };
export type StatsScorecard = {
  generatedAt: string; block: number; purchases: number; symbols: string[]; events: StatsEvent[];
  names: StatsName[];
  totals: { usdSpent: number; value: number; pnlUsd: number; pnlPct: number | null };
  benchmarks?: { basket: StatsBench; spy: StatsBench; smart: StatsBench; smartCapped?: StatsBench };
};
export type StatsShadowRow = { at: number; live: [string, number][]; capped: [string, number][] | null; divergenceBps: number };
export type StatsFeedRow = {
  chamber: string; type: string; symbol: string; notional: number; traded: string; filed: string;
  lagDays: number | null; buyable: boolean; inBasket: boolean;
};
export type StatsMember = {
  slug: string; name: string; chamber: string; buys: number; sells: number;
  buyNotional: number; sellNotional: number; buyableShare: number | null; medianLagDays: number | null;
};
/** One switch: [block, unix seconds, tokenId, 1 on / 0 off, COAT burned by that switch-on]. */
export type StatsActivationEvent = [block: number, ts: number, tokenId: number, active: 0 | 1, burned: number];
export type StatsActivations = {
  generatedAt: string; scannedTo: number; events: StatsActivationEvent[];
  totals: { activations: number; deactivations: number; activeNow: number; burned: number };
};
export type StatsPayload = {
  ok: boolean; generatedAt: string;
  activations?: StatsActivations;
  scorecard?: StatsScorecard;
  shadow?: { rows: StatsShadowRow[] };
  feed?: { generatedAt: string; days: number; rows: StatsFeedRow[] };
  members?: { generatedAt: string; windowDays: number; members: StatsMember[] };
};

async function pull(url: string): Promise<string> {
  const res = await fetch(url, { next: { revalidate }, headers: { "User-Agent": "coattail-site/1.0" } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.text();
}

type Pair = [string, number];
const pairs = (xs: unknown): Pair[] =>
  Array.isArray(xs) ? xs.map((w) => [String((w as { ticker: string }).ticker), Number((w as { bps: number }).bps)] as Pair) : [];

function compactScorecard(raw: string): StatsScorecard {
  const j = JSON.parse(raw);
  const tokens: { token: string; symbol: string }[] = j.tokens ?? [];
  const symbols = tokens.map((t) => t.symbol);
  const index = new Map(tokens.map((t, i) => [t.token.toLowerCase(), i]));
  const events: StatsEvent[] = (j.events ?? [])
    .map((e: { block: number; ts: number; usdIn: number | null; token: string }) =>
      [e.block, e.ts, Number(e.usdIn ?? 0), index.get(String(e.token).toLowerCase()) ?? -1] as StatsEvent)
    .sort((a: StatsEvent, b: StatsEvent) => a[1] - b[1]);
  const names: StatsName[] = (j.names ?? []).map((n: StatsName) => ({
    symbol: n.symbol, buys: n.buys, shares: n.shares, usdSpent: n.usdSpent, avgCost: n.avgCost, price: n.price,
    value: n.value, pnlUsd: n.pnlUsd, pnlPct: n.pnlPct, firstBuy: n.firstBuy, lastBuy: n.lastBuy,
  }));
  const bench = j.benchmarks;
  return {
    generatedAt: j.generatedAt, block: j.block, purchases: j.purchases, symbols, events, names, totals: j.totals,
    benchmarks: bench ? { basket: bench.basket, spy: bench.spy, smart: bench.smart, smartCapped: bench.smartCapped } : undefined,
  };
}

function compactShadow(raw: string): { rows: StatsShadowRow[] } {
  const rows: StatsShadowRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const at = Date.parse(r.at);
      if (!isFinite(at)) continue;
      rows.push({
        at: Math.floor(at / 1000),
        live: pairs(r.live),
        capped: r.shadowCapped ? pairs(r.shadowCapped) : null,
        divergenceBps: Number(r.divergenceBps ?? 0),
      });
    } catch { /* a torn line is skipped, the rest of the history still charts */ }
  }
  rows.sort((a, b) => a.at - b.at);
  // The history grows by ~8 rows a day forever; thin it evenly past a screen's worth.
  const MAX = 720;
  if (rows.length <= MAX) return { rows };
  const stride = rows.length / MAX;
  const thinned: StatsShadowRow[] = [];
  for (let i = 0; i < MAX; i++) thinned.push(rows[Math.floor(i * stride)]);
  if (thinned[thinned.length - 1] !== rows[rows.length - 1]) thinned.push(rows[rows.length - 1]);
  return { rows: thinned };
}

function compactFeed(raw: string): { generatedAt: string; days: number; rows: StatsFeedRow[] } {
  const j = JSON.parse(raw);
  const rows: StatsFeedRow[] = (j.rows ?? []).map((r: Record<string, unknown>) => ({
    chamber: String(r.chamber ?? ""), type: String(r.type ?? "other"), symbol: String(r.symbol ?? ""),
    notional: Number(r.notional ?? 0), traded: String(r.traded ?? ""), filed: String(r.filed ?? ""),
    lagDays: r.lagDays === null || r.lagDays === undefined ? null : Number(r.lagDays),
    buyable: Boolean(r.buyable), inBasket: Boolean(r.inBasket),
  }));
  return { generatedAt: j.generatedAt, days: Number(j.days ?? 30), rows };
}

function compactMembers(raw: string): { generatedAt: string; windowDays: number; members: StatsMember[] } {
  const j = JSON.parse(raw);
  const members: StatsMember[] = (j.members ?? []).map((m: Record<string, unknown>) => ({
    slug: String(m.slug), name: String(m.name), chamber: String(m.chamber ?? ""),
    buys: Number(m.buys ?? 0), sells: Number(m.sells ?? 0),
    buyNotional: Number(m.buyNotional ?? 0), sellNotional: Number(m.sellNotional ?? 0),
    buyableShare: m.buyableShare === null || m.buyableShare === undefined ? null : Number(m.buyableShare),
    medianLagDays: m.medianLagDays === null || m.medianLagDays === undefined ? null : Number(m.medianLagDays),
  }));
  return { generatedAt: j.generatedAt, windowDays: Number(j.windowDays ?? 90), members };
}

function compactActivations(raw: string): StatsActivations {
  const j = JSON.parse(raw);
  const events: StatsActivationEvent[] = (j.events ?? []).map((e: number[]) =>
    [Number(e[0]), Number(e[1]), Number(e[2]), e[3] ? 1 : 0, Number(e[4] ?? 0)] as StatsActivationEvent);
  return { generatedAt: j.generatedAt, scannedTo: Number(j.scannedTo ?? 0), events, totals: j.totals };
}

export async function GET() {
  const [sc, sh, fe, me, ac] = await Promise.allSettled([
    pull(URLS.scorecard), pull(URLS.shadow), pull(URLS.feed), pull(URLS.members), pull(URLS.activations),
  ]);
  const out: StatsPayload = { ok: true, generatedAt: new Date().toISOString() };
  const part = <T,>(r: PromiseSettledResult<string>, f: (raw: string) => T, label: string): T | undefined => {
    if (r.status === "rejected") { console.warn(`stats: ${label} upstream failed:`, String(r.reason)); return undefined; }
    try { return f(r.value); } catch (err) { console.warn(`stats: ${label} unreadable:`, String(err)); return undefined; }
  };
  out.scorecard = part(sc, compactScorecard, "scorecard");
  out.shadow = part(sh, compactShadow, "shadow history");
  out.feed = part(fe, compactFeed, "feed");
  out.members = part(me, compactMembers, "members");
  out.activations = part(ac, compactActivations, "activations");
  if (!out.scorecard && !out.shadow && !out.feed && !out.members && !out.activations) {
    return NextResponse.json({ ok: false, error: "stats unavailable" }, { status: 502 });
  }
  return NextResponse.json(out);
}
