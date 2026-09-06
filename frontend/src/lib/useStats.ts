"use client";

// Data for the Stats tab: one call to /api/stats, which bundles the files the indexer
// publishes every pass (purchases, basket history, filings, members, activation history).
// Persisted in localStorage so a revisit paints instantly and only revalidates in the
// background.

import { useStoredQuery } from "@/lib/useStoredQuery";
import type { StatsPayload } from "@/app/api/stats/route";

export type {
  StatsPayload, StatsScorecard, StatsShadowRow, StatsFeedRow, StatsMember, StatsName, StatsBench,
  StatsActivations, StatsActivationEvent,
} from "@/app/api/stats/route";

async function fetchStats(): Promise<StatsPayload> {
  const res = await fetch("/api/stats");
  const payload = (await res.json()) as StatsPayload;
  if (!res.ok || !payload.ok) throw new Error("stats unavailable");
  return payload;
}

export function useStats() {
  return useStoredQuery<StatsPayload>({
    storageKey: "coattail.stats.v2",
    queryKey: ["stats"],
    queryFn: fetchStats,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    persistIf: (d) => d.ok,
  });
}
