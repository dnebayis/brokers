"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { type Address } from "viem";
import { ADDR, BROKER_DEPLOYMENT_BLOCK } from "./config";
import { brokerAbi } from "./abis";
import { client } from "./client";
import { alchemyOwnedTokenIds } from "./alchemy";

export type OwnedBroker = { id: bigint; active: boolean };

// Find a wallet's Brokers. Primary path: the Alchemy NFT API (one request, scales). Fallback:
// bounded on-chain enumeration. Either way, ownership + active status are confirmed on-chain.
export function useOwnedBrokers() {
  const { address } = useAccount();
  const [brokers, setBrokers] = useState<OwnedBroker[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    const request = ++requestId.current;
    const ownerAddress = address;
    const ownerKey = ownerAddress?.toLowerCase() ?? null;
    // A silent (background poll) refresh keeps the current list on screen while it
    // revalidates, so periodic updates never flash an empty grid.
    if (!silent) {
      setBrokers([]);
      setLoadedFor(null);
    }
    if (!ownerAddress) {
      setBrokers([]);
      setLoadedFor(null);
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const expected = Number(await client.readContract({
        address: ADDR.broker, abi: brokerAbi, functionName: "balanceOf", args: [ownerAddress],
      }));
      if (expected === 0) {
        if (request === requestId.current) {
          setBrokers([]);
          setLoadedFor(ownerKey);
        }
        return;
      }
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
          batch.forEach((id, i) => {
            const owner = results[i * 2]?.result as string | undefined;
            const active = results[i * 2 + 1]?.result as boolean | undefined;
            if (owner && owner.toLowerCase() === ownerKey) out.push({ id, active: !!active });
          });
        }
        return out;
      };

      let owned = await resolveOwned(candidateIds);
      // The fast path can under-count: a lagging/rejected NFT API, a truncated getLogs range,
      // or a dropped multicall result (allowFailure) all yield fewer IDs than `balanceOf`.
      // Whenever the resolved count is short of the on-chain balance, fall back to enumerating
      // the complete 1..MAX_SUPPLY domain so every owned Broker is found. Random mint means the
      // minted set is not 1..totalMinted, so the full domain is required.
      if (owned.length < expected) {
        const maxSupply = Number(await client.readContract({
          address: ADDR.broker, abi: brokerAbi, functionName: "MAX_SUPPLY",
        }));
        owned = await resolveOwned(Array.from({ length: maxSupply }, (_, i) => BigInt(i + 1)));
      }
      owned.sort((a, b) => (a.id < b.id ? -1 : 1));
      if (request === requestId.current) {
        setBrokers(owned);
        setLoadedFor(ownerKey);
      }
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
    load();
    if (!address) return;
    // Poll on-chain ownership/active state so the UI reflects mints, activations
    // and keeper distributions without a manual page refresh.
    const timer = setInterval(() => void load({ silent: true }), 20_000);
    return () => clearInterval(timer);
  }, [load, address]);

  const visibleBrokers = loadedFor === (address?.toLowerCase() ?? null) ? brokers : [];
  return { brokers: visibleBrokers, loading, reload: () => load() };
}
