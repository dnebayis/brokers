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

  const load = useCallback(async () => {
    const request = ++requestId.current;
    const ownerAddress = address;
    const ownerKey = ownerAddress?.toLowerCase() ?? null;
    setBrokers([]);
    setLoadedFor(null);
    if (!ownerAddress) {
      setBrokers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
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
      // NFT APIs can lag directly after mint/activation and can validly return an empty
      // response without throwing. Fall back to bounded on-chain enumeration (max 1,776).
      if (candidateIds.length < expected) {
        const maxSupply = Number(await client.readContract({
          address: ADDR.broker, abi: brokerAbi, functionName: "MAX_SUPPLY",
        }));
        // Random mint means the minted set is not 1..totalMinted. The bounded fallback must
        // inspect the complete 1..MAX_SUPPLY ID domain and tolerate unminted ownerOf calls.
        // This is an availability-only final fallback. Normal discovery is Transfer logs above.
        candidateIds = Array.from({ length: maxSupply }, (_, i) => BigInt(i + 1));
      }
      const owned: OwnedBroker[] = [];
      // Keep each RPC batch bounded. Public RPC providers commonly reject oversized
      // multicalls even though the collection itself is capped at 1,776.
      for (let offset = 0; offset < candidateIds.length; offset += 200) {
        const ids = candidateIds.slice(offset, offset + 200);
        const calls = ids.flatMap((id) => [
          { address: ADDR.broker, abi: brokerAbi, functionName: "ownerOf", args: [id] } as const,
          { address: ADDR.broker, abi: brokerAbi, functionName: "activated", args: [id] } as const,
        ]);
        const results = await client.multicall({ contracts: calls, allowFailure: true });
        ids.forEach((id, i) => {
          const owner = results[i * 2]?.result as string | undefined;
          const active = results[i * 2 + 1]?.result as boolean | undefined;
          if (owner && owner.toLowerCase() === ownerKey) {
            owned.push({ id, active: !!active });
          }
        });
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
  }, [load]);

  const visibleBrokers = loadedFor === (address?.toLowerCase() ?? null) ? brokers : [];
  return { brokers: visibleBrokers, loading, reload: load };
}
