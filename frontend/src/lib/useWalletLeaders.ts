"use client";

// Who holds the most Brokers, and who earns the most.
//
// The second question has an exact answer rather than an estimate: every active Broker
// earns an equal share of every purchase, so a wallet's share of the engine's output is
// simply how many ACTIVE Brokers it holds. Ranking by active count is therefore the true
// earnings ranking, and multiplying by the engine's measured per-Broker rate turns it into
// a live dollar figure without guessing.
//
// Built from three log queries and no per-token calls: Transfer replay gives the current
// holder of every token, Activated/Deactivated give which of them are switched on. Anyone
// can replay the same events and get the same table.

import { parseAbiItem } from "viem";
import { ADDR, BROKER_DEPLOYMENT_BLOCK } from "./config";
import { publicClient as client } from "./client";
import { useStoredQuery } from "./useStoredQuery";

export type WalletLeader = {
  rank: number;
  address: `0x${string}`;
  held: number;
  active: number;
  /** Share of the whole earning set, 0..1 — the wallet's slice of every purchase. */
  share: number;
};

type Stored = { leaders: WalletLeader[]; totalActive: number; holders: number };

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const ACTIVATED = parseAbiItem("event Activated(uint256 indexed tokenId, address indexed owner, uint256 coatBurned)");
const DEACTIVATED = parseAbiItem("event Deactivated(uint256 indexed tokenId)");

function after(a: { blockNumber: bigint; logIndex: number }, b: { blockNumber: bigint; logIndex: number }) {
  return a.blockNumber > b.blockNumber || (a.blockNumber === b.blockNumber && a.logIndex > b.logIndex);
}

async function load(limit: number): Promise<Stored> {
  const [transfers, acts, deacts] = await Promise.all([
    client.getLogs({ address: ADDR.broker, event: TRANSFER, fromBlock: BROKER_DEPLOYMENT_BLOCK }),
    client.getLogs({ address: ADDR.broker, event: ACTIVATED, fromBlock: BROKER_DEPLOYMENT_BLOCK }),
    client.getLogs({ address: ADDR.broker, event: DEACTIVATED, fromBlock: BROKER_DEPLOYMENT_BLOCK }),
  ]);

  // Current holder per token: the last Transfer wins.
  const ownerOf = new Map<string, `0x${string}`>();
  const seen = new Map<string, { blockNumber: bigint; logIndex: number }>();
  for (const l of transfers) {
    if (l.args.tokenId === undefined || !l.args.to) continue;
    const key = l.args.tokenId.toString();
    const at = { blockNumber: l.blockNumber!, logIndex: l.logIndex! };
    const prev = seen.get(key);
    if (!prev || after(at, prev)) {
      seen.set(key, at);
      ownerOf.set(key, l.args.to as `0x${string}`);
    }
  }

  // Active per token: the last state-changing event wins.
  const state = new Map<string, { blockNumber: bigint; logIndex: number; active: boolean }>();
  const consider = (id: bigint, blockNumber: bigint, logIndex: number, active: boolean) => {
    const key = id.toString();
    const ev = { blockNumber, logIndex, active };
    const prev = state.get(key);
    if (!prev || after(ev, prev)) state.set(key, ev);
  };
  for (const l of acts) if (l.args.tokenId !== undefined) consider(l.args.tokenId, l.blockNumber!, l.logIndex!, true);
  for (const l of deacts) if (l.args.tokenId !== undefined) consider(l.args.tokenId, l.blockNumber!, l.logIndex!, false);

  const rows = new Map<string, { held: number; active: number }>();
  for (const [id, owner] of ownerOf) {
    const key = owner.toLowerCase();
    const row = rows.get(key) ?? { held: 0, active: 0 };
    row.held += 1;
    if (state.get(id)?.active) row.active += 1;
    rows.set(key, row);
  }

  let totalActive = 0;
  for (const r of rows.values()) totalActive += r.active;

  const leaders = [...rows.entries()]
    .map(([address, r]) => ({ address: address as `0x${string}`, ...r }))
    // active first (that is the earning rank), holdings as the tiebreak
    .sort((a, b) => b.active - a.active || b.held - a.held)
    .slice(0, limit)
    .map((r, i) => ({
      rank: i + 1,
      address: r.address,
      held: r.held,
      active: r.active,
      share: totalActive > 0 ? r.active / totalActive : 0,
    }));

  return { leaders, totalActive, holders: rows.size };
}

export function useWalletLeaders(limit = 15) {
  const q = useStoredQuery<Stored>({
    storageKey: `coattail.walletLeaders.v1.${limit}`,
    queryKey: ["walletLeaders", limit],
    queryFn: () => load(limit),
    // Replaying every transfer is a ~9k-log read on mainnet, so keep it cached for an hour:
    // holdings move slowly, and this tab is not the landing page.
    staleTime: 60 * 60 * 1000,
  });
  return {
    leaders: q.data?.leaders ?? [],
    totalActive: q.data?.totalActive ?? 0,
    holders: q.data?.holders ?? 0,
    loading: q.isLoading && !q.data,
    error: q.error,
  };
}
