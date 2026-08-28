"use client";

// Values the real stock behind a set of owned Brokers, two ways:
//   backing — what each Broker holds RIGHT NOW (claimable + stock in its wallet);
//   earned  — what each Broker produced since its CURRENT activation (claims logged
//             after the latest switch-on + claimable), which never shrinks when the
//             owner withdraws or sells the stock.
// The Activate tab shows both: "worth at least X" and "earned Y since you switched it on".

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { loadKnownTokens, brokerBacking, earnedSinceActivation } from "./brokerValue";

export function useBrokerBacking(ids: bigint[]) {
  const { address } = useAccount();
  const key = ids.map((i) => i.toString()).join(",");
  const [byId, setById] = useState<Record<string, number>>({});
  const [earnedById, setEarnedById] = useState<Record<string, number>>({});
  const [totalUsd, setTotalUsd] = useState<number | null>(null);
  const [totalEarnedUsd, setTotalEarnedUsd] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    if (ids.length === 0) {
      setById({});
      setEarnedById({});
      setTotalUsd(null);
      setTotalEarnedUsd(null);
      return;
    }
    (async () => {
      setLoading(true);
      try {
        const metas = await loadKnownTokens();
        const [results, earned] = await Promise.all([
          Promise.all(
            ids.map(async (id) => {
              try {
                const b = await brokerBacking(id, metas);
                return [id.toString(), b.totalUsd] as const;
              } catch {
                return [id.toString(), 0] as const;
              }
            }),
          ),
          earnedSinceActivation(ids, metas, address).catch(() => ({}) as Record<string, number>),
        ]);
        if (!live) return;
        const map: Record<string, number> = {};
        let total = 0;
        for (const [id, v] of results) {
          map[id] = v;
          total += v;
        }
        setById(map);
        setTotalUsd(total);
        setEarnedById(earned);
        const earnedVals = Object.values(earned);
        setTotalEarnedUsd(earnedVals.length ? earnedVals.reduce((a, b) => a + b, 0) : null);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, address]);

  return { byId, earnedById, totalUsd, totalEarnedUsd, loading };
}
