"use client";

// Values the real stock backing a set of owned Brokers: a per-token map and the total,
// so the Activate tab can show "your NFT is worth at least the stock inside it."

import { useEffect, useState } from "react";
import { loadKnownTokens, brokerBacking } from "./brokerValue";

export function useBrokerBacking(ids: bigint[]) {
  const key = ids.map((i) => i.toString()).join(",");
  const [byId, setById] = useState<Record<string, number>>({});
  const [totalUsd, setTotalUsd] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    if (ids.length === 0) {
      setById({});
      setTotalUsd(null);
      return;
    }
    (async () => {
      setLoading(true);
      try {
        const metas = await loadKnownTokens();
        const results = await Promise.all(
          ids.map(async (id) => {
            try {
              const b = await brokerBacking(id, metas);
              return [id.toString(), b.totalUsd] as const;
            } catch {
              return [id.toString(), 0] as const;
            }
          }),
        );
        if (!live) return;
        const map: Record<string, number> = {};
        let total = 0;
        for (const [id, v] of results) {
          map[id] = v;
          total += v;
        }
        setById(map);
        setTotalUsd(total);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { byId, totalUsd, loading };
}
