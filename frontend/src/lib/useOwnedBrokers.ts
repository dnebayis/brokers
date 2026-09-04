"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { type Address } from "viem";
import { ADDR, BROKER_DEPLOYMENT_BLOCK } from "./config";
import { brokerAbi } from "./abis";
import { client } from "./client";
import { alchemyOwnedTokenIds } from "./alchemy";

// `active: null` means the chain did not answer, NOT that the Broker is off. Rendering an
// unanswered read as "OFF" was showing people's working Brokers as switched off whenever the
// RPC was rate limited, which is exactly when it is least excusable.
export type OwnedBroker = { id: bigint; active: boolean | null };

// One store per wallet, shared by every component that calls the hook (the side panel and
// My Brokers both do): concurrent loads collapse into one request, a fresh snapshot is served
// without touching the RPC, and the 1..MAX_SUPPLY fallback scan (18 multicalls) runs at most
// once per cooldown instead of on every 60 s poll when the wide getLogs is being refused.
type Snapshot = { owned: OwnedBroker[]; at: number };
const snapshots = new Map<string, Snapshot>();
const inflight = new Map<string, Promise<OwnedBroker[]>>();
const lastFullScan = new Map<string, number>();
const FRESH_MS = 20_000;
const FULL_SCAN_COOLDOWN_MS = 10 * 60_000;

function sameList(a: OwnedBroker[], b: OwnedBroker[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id || a[i].active !== b[i].active) return false;
  return true;
}

function loadShared(ownerAddress: Address, force: boolean): Promise<OwnedBroker[]> {
  const key = ownerAddress.toLowerCase();
  const snap = snapshots.get(key);
  if (!force && snap && Date.now() - snap.at < FRESH_MS) return Promise.resolve(snap.owned);
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchOwned(ownerAddress, key)
    .then((owned) => {
      snapshots.set(key, { owned, at: Date.now() });
      return owned;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Find a wallet's Brokers. Primary path: inbound Transfer logs, then the Alchemy NFT API.
// Fallback: bounded on-chain enumeration. Either way, ownership + active status are confirmed
// on-chain.
async function fetchOwned(ownerAddress: Address, ownerKey: string): Promise<OwnedBroker[]> {
  const expected = Number(await client.readContract({
    address: ADDR.broker, abi: brokerAbi, functionName: "balanceOf", args: [ownerAddress],
  }));
  if (expected === 0) return [];
  {
      let candidateIds: bigint[] = [];
      try {
        // ERC-721 Transfer logs are authoritative and return only this wallet's inbound IDs.
        // This replaces a 1,776-ID ownerOf scan when a third-party NFT API is delayed or denied.
        const inbound = await client.getLogs({
          address: ADDR.broker,
          event: brokerAbi[0],
          args: { to: ownerAddress },
          fromBlock: BROKER_DEPLOYMENT_BLOCK,
        });
        candidateIds = [...new Set(inbound.map((log) => log.args.tokenId).filter((id): id is bigint => id !== undefined))];
      } catch {
        try {
          candidateIds = await alchemyOwnedTokenIds(ownerAddress, ADDR.broker as Address);
        } catch {
          candidateIds = [];
        }
      }

      // Resolve current ownership for a set of candidate IDs, in bounded multicall batches.
      // Public RPC providers commonly reject oversized multicalls, so keep each batch small.
      const resolveOwned = async (ids: bigint[]): Promise<OwnedBroker[]> => {
        const out: OwnedBroker[] = [];
        for (let offset = 0; offset < ids.length; offset += 200) {
          const batch = ids.slice(offset, offset + 200);
          const calls = batch.flatMap((id) => [
            { address: ADDR.broker, abi: brokerAbi, functionName: "ownerOf", args: [id] } as const,
            { address: ADDR.broker, abi: brokerAbi, functionName: "activated", args: [id] } as const,
          ]);
          const results = await client.multicall({ contracts: calls, allowFailure: true });
          const mine: { id: bigint; active: boolean | null }[] = [];
          const unanswered: bigint[] = [];
          batch.forEach((id, i) => {
            const owner = results[i * 2]?.result as string | undefined;
            const activeRes = results[i * 2 + 1];
            if (!owner || owner.toLowerCase() !== ownerKey) return;
            if (activeRes?.status === "success") {
              mine.push({ id, active: !!activeRes.result });
            } else {
              mine.push({ id, active: null });
              unanswered.push(id);
            }
          });
          // One retry for the reads the batch dropped, as plain single calls: a rate-limited
          // or oversized multicall fails per item, and a single read usually succeeds.
          if (unanswered.length > 0) {
            const retried = await Promise.all(
              unanswered.map(async (id) => {
                try {
                  const a = await client.readContract({
                    address: ADDR.broker, abi: brokerAbi, functionName: "activated", args: [id],
                  });
                  return [id, !!a] as const;
                } catch {
                  return [id, null] as const;
                }
              }),
            );
            const fixed = new Map(retried.map(([id, a]) => [id.toString(), a]));
            for (const row of mine) {
              const v = fixed.get(row.id.toString());
              if (v !== undefined) row.active = v;
            }
          }
          out.push(...mine);
        }
        return out;
      };

      let owned = await resolveOwned(candidateIds);
      // The fast path can under-count: a lagging/rejected NFT API, a truncated getLogs range,
      // or a dropped multicall result (allowFailure) all yield fewer IDs than `balanceOf`.
      // Whenever the resolved count is short of the on-chain balance, fall back to enumerating
      // the complete 1..MAX_SUPPLY domain so every owned Broker is found. Random mint means the
      // minted set is not 1..totalMinted, so the full domain is required. The scan is heavy on
      // a rate-limited RPC, so between scans the last complete snapshot stands in.
      if (owned.length < expected) {
        const previous = snapshots.get(ownerKey);
        const scannedAt = lastFullScan.get(ownerKey) ?? 0;
        if (previous && previous.owned.length >= expected && Date.now() - scannedAt < FULL_SCAN_COOLDOWN_MS) {
          const known = new Map(previous.owned.map((b) => [b.id.toString(), b]));
          for (const b of owned) known.set(b.id.toString(), b); // fresher active flags win
          owned = [...known.values()];
        } else {
          lastFullScan.set(ownerKey, Date.now());
          const maxSupply = Number(await client.readContract({
            address: ADDR.broker, abi: brokerAbi, functionName: "MAX_SUPPLY",
          }));
          owned = await resolveOwned(Array.from({ length: maxSupply }, (_, i) => BigInt(i + 1)));
        }
      }
      owned.sort((a, b) => (a.id < b.id ? -1 : 1));
      return owned;
  }
}

export function useOwnedBrokers() {
  const { address } = useAccount();
  const key = address?.toLowerCase() ?? null;
  // Seed from the shared snapshot so a second consumer (or a remount) never flashes empty.
  const [brokers, setBrokers] = useState<OwnedBroker[]>(() => (key && snapshots.get(key)?.owned) || []);
  const [loading, setLoading] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(() => (key && snapshots.has(key) ? key : null));
  const requestId = useRef(0);

  const load = useCallback(async (options?: { silent?: boolean; force?: boolean }) => {
    const silent = options?.silent === true;
    const request = ++requestId.current;
    const ownerAddress = address;
    const ownerKey = ownerAddress?.toLowerCase() ?? null;
    if (!ownerAddress || !ownerKey) {
      setBrokers([]);
      setLoadedFor(null);
      setLoading(false);
      return;
    }
    // A silent (background poll) refresh keeps the current list on screen while it
    // revalidates, so periodic updates never flash an empty grid.
    if (!silent && !snapshots.has(ownerKey)) setLoading(true);
    try {
      const owned = await loadShared(ownerAddress, options?.force === true);
      if (request !== requestId.current) return;
      // Structural sharing: an unchanged list must not re-fire every effect keyed on it.
      setBrokers((prev) => (sameList(prev, owned) ? prev : owned));
      setLoadedFor(ownerKey);
    } catch {
      if (request === requestId.current) {
        setBrokers([]);
        setLoadedFor(ownerKey);
      }
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void load();
    if (!address) return;
    // Poll on-chain ownership/active state so the UI reflects mints, activations
    // and keeper distributions without a manual page refresh.
    const timer = setInterval(() => void load({ silent: true }), 60_000);
    return () => clearInterval(timer);
  }, [load, address]);

  const visibleBrokers = loadedFor === key ? brokers : [];
  return { brokers: visibleBrokers, loading, reload: () => load({ force: true }) };
}
