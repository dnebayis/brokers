"use client";

// One shared price source for "how many dollars is that": ETH/USD from the Booster's own
// Chainlink feed (the same one its guards use) and $COAT/USD from that price divided by the
// hooked pool's spot quote. Persisted like the other ambient reads so a reload paints the
// last known figure instantly and refreshes in the background.

import { formatUnits, zeroAddress } from "viem";
import { ADDR } from "./config";
import { boosterAbi, routerAbi, aggregatorAbi } from "./abis";
import { publicClient as client } from "./client";
import { useStoredQuery } from "./useStoredQuery";

export type CoatPrice = { ethUsd: number; coatUsd: number };

async function loadCoatPrice(): Promise<CoatPrice> {
  const feed = await client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "ethUsdFeed" });
  let ethUsd = 0;
  if (feed && feed !== zeroAddress) {
    const [dec, rd] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: feed, abi: aggregatorAbi, functionName: "decimals" },
        { address: feed, abi: aggregatorAbi, functionName: "latestRoundData" },
      ],
    });
    ethUsd = Number(formatUnits(rd[1], Number(dec)));
  }
  let coatUsd = 0;
  if (ADDR.router && ethUsd > 0) {
    const coatPerEth = await client.readContract({
      address: ADDR.router as `0x${string}`, abi: routerAbi, functionName: "quoteBuy", args: [10n ** 18n],
    });
    const perEth = Number(formatUnits(coatPerEth, 18));
    if (perEth > 0) coatUsd = ethUsd / perEth;
  }
  return { ethUsd, coatUsd };
}

/** Pass `ssrSafe: true` from any component that is server-rendered (the /trade page, for
 *  one): the stored price is then hidden for the first client render so hydration matches
 *  the server's empty state, and revealed right after mount. */
export function useCoatPrice(opts?: { ssrSafe?: boolean }) {
  const { data } = useStoredQuery<CoatPrice>({
    storageKey: "coat:price:v1",
    queryKey: ["coat-price", ADDR.router],
    queryFn: loadCoatPrice,
    staleTime: 60_000,
    refetchInterval: 120_000,
    ssrSafe: opts?.ssrSafe,
    persistIf: (d) => d.ethUsd > 0,
  });
  const ethUsd = data?.ethUsd ?? 0;
  const coatUsd = data?.coatUsd ?? 0;
  return {
    ethUsd,
    coatUsd,
    ready: ethUsd > 0 && coatUsd > 0,
    /** Dollar value of a raw 18-decimal COAT amount, or undefined until the price is known. */
    coatWeiToUsd: (wei: bigint | undefined) =>
      wei === undefined || coatUsd <= 0 ? undefined : Number(formatUnits(wei, 18)) * coatUsd,
    ethWeiToUsd: (wei: bigint | undefined) =>
      wei === undefined || ethUsd <= 0 ? undefined : Number(formatUnits(wei, 18)) * ethUsd,
  };
}

/** "$1,234" / "$0.42" / "$0.00036"; dash when unknown. Dust below a thousandth of a
 *  cent reads as "$0": a wallet holding a few wei of $COAT is worth nothing, not "$1.3e-16". */
export function usdLabel(n: number | undefined): string {
  if (n === undefined || !isFinite(n)) return "—";
  if (n < 0.00001) return "$0";
  if (n >= 1) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 2 });
  return "$" + n.toPrecision(2);
}
