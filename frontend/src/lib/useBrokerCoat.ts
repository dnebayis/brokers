"use client";

// $COAT sitting inside Broker wallets. Salary is stock, but COAT can land in a Broker's
// ERC-6551 wallet too (holder distributions, tips), and it travels with the NFT like
// everything else in there. One multicall for every owned Broker, refreshed on demand.

import { useEffect, useState } from "react";
import { ADDR } from "./config";
import { coatAbi } from "./abis";
import { publicClient as client } from "./client";

export function useBrokerCoat(walletsById: Record<string, string>, reloadKey = 0) {
  const [byId, setById] = useState<Record<string, bigint>>({});
  const entries = Object.entries(walletsById).filter(([, w]) => !!w);
  const key = entries.map(([id]) => id).join(",");

  useEffect(() => {
    let stale = false;
    if (entries.length === 0) {
      setById({});
      return;
    }
    client
      .multicall({
        allowFailure: true,
        contracts: entries.map(([, wallet]) => ({
          address: ADDR.coat,
          abi: coatAbi,
          functionName: "balanceOf" as const,
          args: [wallet as `0x${string}`] as const,
        })),
      })
      .then((res) => {
        if (stale) return;
        const next: Record<string, bigint> = {};
        entries.forEach(([id], i) => {
          const v = res[i]?.result;
          if (typeof v === "bigint") next[id] = v;
        });
        setById(next);
      })
      .catch(() => { /* leave the previous map; the next reload retries */ });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reloadKey]);

  const total = Object.values(byId).reduce((a, b) => a + b, 0n);
  return { byId, total };
}
