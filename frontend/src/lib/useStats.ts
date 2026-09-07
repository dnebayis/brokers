"use client";

// Data for the Stats tab: one call to /api/stats, which bundles the files the indexer
// publishes every pass (purchases, basket history, filings, members, activation history).
// Persisted in localStorage so a revisit paints instantly and only revalidates in the
// background.

import { useStoredQuery } from "@/lib/useStoredQuery";
import type { StatsPayload, StatsShadowRow } from "@/app/api/stats/route";

export type {
  StatsPayload, StatsScorecard, StatsShadowRow, StatsFeedRow, StatsMember, StatsName, StatsBench,
  StatsActivations, StatsActivationEvent,
} from "@/app/api/stats/route";

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Fill every array the tab iterates, so a partial or older-shaped payload renders as
 *  "unavailable" sections instead of throwing. Runs on fetch (and so on what gets cached). */
export function normalizeStats(p: StatsPayload): StatsPayload {
  const out: StatsPayload = { ok: !!p.ok, generatedAt: String(p.generatedAt ?? "") };
  if (p.scorecard && p.scorecard.totals) {
    out.scorecard = { ...p.scorecard, symbols: arr(p.scorecard.symbols), events: arr(p.scorecard.events), names: arr(p.scorecard.names) };
  }
  if (p.shadow) {
    out.shadow = {
      rows: arr<StatsShadowRow>(p.shadow.rows).map((r) => ({
        at: Number(r.at) || 0,
        live: arr(r.live),
        smart: arr(r.smart),
        capped: r.capped ? arr(r.capped) : null,
        divergenceBps: Number(r.divergenceBps) || 0,
        posted: r.posted === "smart" || r.posted === "capped" ? r.posted : "conviction",
      })),
    };
  }
  if (p.feed) out.feed = { ...p.feed, rows: arr(p.feed.rows) };
  if (p.members) out.members = { ...p.members, members: arr(p.members.members) };
  if (p.activations && p.activations.totals) out.activations = { ...p.activations, events: arr(p.activations.events) };
  return out;
}

async function fetchStats(): Promise<StatsPayload> {
  const res = await fetch("/api/stats");
  const payload = (await res.json()) as StatsPayload;
  if (!res.ok || !payload.ok) throw new Error("stats unavailable");
  return normalizeStats(payload);
}

export function useStats() {
  return useStoredQuery<StatsPayload>({
    storageKey: "coattail.stats.v3", // v2 caches predate `smart`/`posted` and crashed the tab
    queryKey: ["stats"],
    queryFn: fetchStats,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    persistIf: (d) => d.ok && !!d.shadow && d.shadow.rows.every((r) => Array.isArray(r.smart) && Array.isArray(r.live)),
  });
}
