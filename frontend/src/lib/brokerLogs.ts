"use client";

// Per-Broker event history (Activated, Claimed) with an incremental localStorage cache.
//
// The old path asked for both events across the whole collection history with one
// getLogs per event and a 15-id topic list. The public RPC rejects multi-id topic lists
// and wide ranges outright ("Missing or invalid parameters"), so every My Brokers load
// spent seconds failing there before the fallback answered, and the earned line showed
// late or not at all. Now each Broker gets its own tiny query (one indexed topic, which
// every RPC serves in ~300 ms), and the result is cached per id with the block it was
// scanned to, so the next visit only reads the blocks since. Logs are immutable history:
// caching them is safe; only the window since `scannedTo` can bring anything new.

import { parseAbiItem } from "viem";
import { ADDR, BROKER_DEPLOYMENT_BLOCK } from "./config";
import { client } from "./client";

export type ActivationLog = { block: number; by: string };
export type ClaimLog = { block: number; token: string; amount: string };
export type BrokerLogs = { scannedTo: number; activations: ActivationLog[]; claims: ClaimLog[] };

const ACTIVATED = parseAbiItem("event Activated(uint256 indexed tokenId, address indexed owner, uint256 coatBurned)");
const CLAIMED = parseAbiItem("event Claimed(uint256 indexed tokenId, address indexed to, address token, uint256 amount)");
const KEY = (id: string) => `coattail.logs.v1:${ADDR.broker.toLowerCase()}:${id}`;
const CONCURRENCY = 2; // the public RPC throttles bursts; two in flight stays under it

function readCache(id: string): BrokerLogs | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY(id));
    if (!raw) return null;
    const v = JSON.parse(raw) as BrokerLogs;
    if (typeof v.scannedTo !== "number" || !Array.isArray(v.activations) || !Array.isArray(v.claims)) return null;
    return v;
  } catch {
    return null;
  }
}

function writeCache(id: string, v: BrokerLogs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY(id), JSON.stringify(v));
  } catch {
    /* quota: the next visit rescans, nothing is wrong */
  }
}

async function scanOne(id: bigint, from: bigint, to: bigint): Promise<{ activations: ActivationLog[]; claims: ClaimLog[] }> {
  const [acts, claims] = await Promise.all([
    client.getLogs({ address: ADDR.broker, event: ACTIVATED, args: { tokenId: id }, fromBlock: from, toBlock: to }),
    client.getLogs({ address: ADDR.booster, event: CLAIMED, args: { tokenId: id }, fromBlock: from, toBlock: to }),
  ]);
  return {
    activations: acts.map((l) => ({ block: Number(l.blockNumber), by: String(l.args.owner).toLowerCase() })),
    claims: claims.map((l) => ({ block: Number(l.blockNumber), token: String(l.args.token).toLowerCase(), amount: (l.args.amount ?? 0n).toString() })),
  };
}

/** Activation and claim history per Broker id, cached and scanned incrementally. A Broker
 *  whose scan fails keeps whatever the cache held (possibly nothing) and is retried next time. */
export async function loadBrokerLogs(ids: bigint[]): Promise<Map<string, BrokerLogs>> {
  const out = new Map<string, BrokerLogs>();
  if (ids.length === 0) return out;
  const latest = Number(await client.getBlockNumber());
  const queue = [...ids];
  const worker = async () => {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      const key = id.toString();
      const cached = readCache(key) ?? { scannedTo: Number(BROKER_DEPLOYMENT_BLOCK) - 1, activations: [], claims: [] };
      if (cached.scannedTo >= latest) {
        out.set(key, cached);
        continue;
      }
      try {
        const fresh = await scanOne(id, BigInt(cached.scannedTo + 1), BigInt(latest));
        const merged: BrokerLogs = {
          scannedTo: latest,
          activations: [...cached.activations, ...fresh.activations],
          claims: [...cached.claims, ...fresh.claims],
        };
        writeCache(key, merged);
        out.set(key, merged);
      } catch {
        out.set(key, cached); // stale but honest: earned may read low until the next visit
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  return out;
}

const CARRY_KEY = (id: string, block: number) => `coattail.carry.v1:${ADDR.booster.toLowerCase()}:${id}:${block}`;

/** The claimable() snapshot at a Broker's activation block never changes: cache it forever. */
export function readCarryover(id: string, block: number): Record<string, string> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CARRY_KEY(id, block));
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export function writeCarryover(id: string, block: number, amounts: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CARRY_KEY(id, block), JSON.stringify(amounts));
  } catch {
    /* best effort */
  }
}
