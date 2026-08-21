"use client";

// A verifiable ranking of Brokers by how long each has been continuously earning. Every
// active Broker accrues equally per poke, so the earliest-activated ones that never left
// the earning set have the deepest track record — the collection's OGs. Built from the
// contract's own Activated / Deactivated events (two log queries), so anyone can replay it.
//
// Persisted across reloads via useStoredQuery: a refresh renders the last ranking
// instantly from localStorage with no RPC calls, then revalidates in the background.
// Activations are rare, so 10-minute staleness is invisible.

import { parseAbiItem } from "viem";
import { ADDR, BROKER_DEPLOYMENT_BLOCK } from "./config";
import { publicClient as client } from "./client";
import { useStoredQuery } from "./useStoredQuery";

export type LeaderEntry = { rank: number; id: bigint; sinceBlock: bigint; sinceMs: number | null };

// BigInt doesn't survive JSON.stringify, so the stored shape carries strings; the hook
// converts back so consumers keep the bigint API.
type StoredEntry = { rank: number; id: string; sinceBlock: string; sinceMs: number | null };

const ACTIVATED = parseAbiItem("event Activated(uint256 indexed tokenId, address indexed owner, uint256 coatBurned)");
const DEACTIVATED = parseAbiItem("event Deactivated(uint256 indexed tokenId)");

// Order two logs by (block, logIndex) so the latest event per token wins deterministically.
function after(a: { blockNumber: bigint; logIndex: number }, b: { blockNumber: bigint; logIndex: number }) {
  return a.blockNumber > b.blockNumber || (a.blockNumber === b.blockNumber && a.logIndex > b.logIndex);
}

async function loadLeaderboard(limit: number): Promise<StoredEntry[]> {
  const [acts, deacts] = await Promise.all([
    client.getLogs({ address: ADDR.broker, event: ACTIVATED, fromBlock: BROKER_DEPLOYMENT_BLOCK }),
    client.getLogs({ address: ADDR.broker, event: DEACTIVATED, fromBlock: BROKER_DEPLOYMENT_BLOCK }),
  ]);

  // Per token, keep the latest state-changing event. If it's an Activation, the token
  // is currently active and its streak began at that block.
  type Ev = { blockNumber: bigint; logIndex: number; active: boolean };
  const latest = new Map<string, Ev>();
  const consider = (id: bigint, blockNumber: bigint, logIndex: number, active: boolean) => {
    const key = id.toString();
    const prev = latest.get(key);
    const ev = { blockNumber, logIndex, active };
    if (!prev || after(ev, prev)) latest.set(key, ev);
  };
  for (const l of acts) if (l.args.tokenId !== undefined) consider(l.args.tokenId, l.blockNumber!, l.logIndex!, true);
  for (const l of deacts) if (l.args.tokenId !== undefined) consider(l.args.tokenId, l.blockNumber!, l.logIndex!, false);

  const activeNow = [...latest.entries()]
    .filter(([, ev]) => ev.active)
    .map(([id, ev]) => ({ id, sinceBlock: ev.blockNumber }))
    .sort((a, b) => (a.sinceBlock < b.sinceBlock ? -1 : a.sinceBlock > b.sinceBlock ? 1 : 0))
    .slice(0, limit);

  // Timestamp only the rows we show, so the query stays cheap.
  return Promise.all(
    activeNow.map(async (e, i) => {
      let sinceMs: number | null = null;
      try {
        const block = await client.getBlock({ blockNumber: e.sinceBlock });
        sinceMs = Number(block.timestamp) * 1000;
      } catch {
        sinceMs = null;
      }
      return { rank: i + 1, id: e.id, sinceBlock: e.sinceBlock.toString(), sinceMs };
    }),
  );
}

export function useLeaderboard(limit = 25) {
  const { data, isLoading, isError } = useStoredQuery<StoredEntry[]>({
    storageKey: `coattail.leaders.v1.${limit}`,
    queryKey: ["leaderboard", limit],
    queryFn: () => loadLeaderboard(limit),
    staleTime: 10 * 60_000,
  });
  const entries: LeaderEntry[] = (data ?? []).map((e) => ({
    rank: e.rank,
    id: BigInt(e.id),
    sinceBlock: BigInt(e.sinceBlock),
    sinceMs: e.sinceMs,
  }));
  return { entries, loading: isLoading, error: isError && !data };
}
