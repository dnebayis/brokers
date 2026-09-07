import { formatUnits, zeroAddress, type Address } from "viem";
import { ADDR } from "@/lib/config";
import { aggregatorAbi, boosterAbi } from "@/lib/abis";
import { publicClient } from "@/lib/client";
import { brokerSnapshot, type TokenAmount } from "@/lib/brokerApi";
import { ART_BYTES } from "./png";

// Chain reads behind a pass: the Broker's snapshot (owner, wallet, active, holdings +
// claimable), USD prices from the Booster's Chainlink feeds, and the on-chain artwork.

const rendererAbi = [
  { type: "function", name: "bitmapOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bytes" }] },
] as const;

export type BrokerPassState = {
  id: number;
  owner: string; // checksummed
  wallet: string;
  active: boolean;
  holdings: { symbol: string; formatted: string; usd: number | null; units: string }[];
  units: Record<string, string>;
  balanceUsd: number | null;
  claimableUsd: number | null;
};

const priceCache = new Map<string, { at: number; priceUsd: number | null }>();
const PRICE_TTL_MS = 5 * 60 * 1000;

/** USD per whole token for each address, from Booster.stockFeed → Chainlink; null when the
 *  Booster has no feed for it (e.g. $COAT sitting in the wallet). */
async function pricesFor(tokens: Address[]): Promise<Map<string, number | null>> {
  const now = Date.now();
  const out = new Map<string, number | null>();
  const missing: Address[] = [];
  for (const t of tokens) {
    const c = priceCache.get(t.toLowerCase());
    if (c && now - c.at < PRICE_TTL_MS) out.set(t.toLowerCase(), c.priceUsd);
    else missing.push(t);
  }
  if (missing.length > 0) {
    const feeds = await publicClient.multicall({
      contracts: missing.map((token) => ({ address: ADDR.booster, abi: boosterAbi, functionName: "stockFeed", args: [token] } as const)),
      allowFailure: true,
    });
    const feedOf = missing.map((t, i) => {
      const f = feeds[i]?.result as Address | undefined;
      return f && f !== zeroAddress ? { token: t, feed: f } : { token: t, feed: null };
    });
    const withFeed = feedOf.filter((f): f is { token: Address; feed: Address } => f.feed !== null);
    const reads = withFeed.length
      ? await publicClient.multicall({
          contracts: withFeed.flatMap((f) => [
            { address: f.feed, abi: aggregatorAbi, functionName: "decimals" } as const,
            { address: f.feed, abi: aggregatorAbi, functionName: "latestRoundData" } as const,
          ]),
          allowFailure: true,
        })
      : [];
    withFeed.forEach((f, i) => {
      const dec = reads[i * 2]?.result as number | undefined;
      const rd = reads[i * 2 + 1]?.result as readonly [bigint, bigint, bigint, bigint, bigint] | undefined;
      const price = dec !== undefined && rd ? Number(formatUnits(rd[1], Number(dec))) : null;
      const priceUsd = price !== null && Number.isFinite(price) && price > 0 ? price : null;
      priceCache.set(f.token.toLowerCase(), { at: now, priceUsd });
      out.set(f.token.toLowerCase(), priceUsd);
    });
    for (const f of feedOf) {
      if (f.feed === null) {
        priceCache.set(f.token.toLowerCase(), { at: now, priceUsd: null });
        out.set(f.token.toLowerCase(), null);
      }
    }
  }
  return out;
}

function usdOf(a: TokenAmount, price: number | null): number | null {
  if (price === null) return null;
  return Number(formatUnits(BigInt(a.amount), a.decimals)) * price;
}

/** null = the Broker does not exist. Throws on chain-read failure. */
export async function readBrokerPassState(id: number): Promise<BrokerPassState | null> {
  const snap = await brokerSnapshot(id);
  if (!snap) return null;
  const tokens = [...new Set([...snap.holdings, ...snap.claimable].map((a) => a.token.toLowerCase()))] as Address[];
  const prices = await pricesFor(tokens);

  // merge wallet + claimable per symbol
  const merged = new Map<string, { symbol: string; decimals: number; raw: bigint; usd: number | null; priced: boolean }>();
  const add = (a: TokenAmount) => {
    const key = a.symbol;
    const price = prices.get(a.token.toLowerCase()) ?? null;
    const cur = merged.get(key) ?? { symbol: a.symbol, decimals: a.decimals, raw: 0n, usd: 0, priced: true };
    cur.raw += BigInt(a.amount);
    const u = usdOf(a, price);
    if (u === null) cur.priced = false;
    else cur.usd = (cur.usd ?? 0) + u;
    merged.set(key, cur);
  };
  snap.holdings.forEach(add);
  snap.claimable.forEach(add);

  let balanceUsd: number | null = 0;
  let claimableUsd: number | null = 0;
  const holdings = [...merged.values()]
    .map((m) => {
      const usd = m.priced ? m.usd : null;
      if (usd === null) {
        // an unpriced holding (e.g. $COAT) doesn't blank the balance; it's simply not counted
      } else if (balanceUsd !== null) balanceUsd += usd;
      return { symbol: m.symbol, formatted: fmtUnits(m.raw, m.decimals), usd, units: m.raw.toString() };
    })
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  for (const c of snap.claimable) {
    const u = usdOf(c, prices.get(c.token.toLowerCase()) ?? null);
    if (u !== null && claimableUsd !== null) claimableUsd += u;
  }
  // No feed answered at all while something is held → we genuinely don't know the balance.
  if (holdings.length > 0 && holdings.every((h) => h.usd === null)) {
    balanceUsd = null;
    claimableUsd = null;
  }

  const units: Record<string, string> = {};
  for (const h of holdings) units[h.symbol] = h.units;
  return { id, owner: snap.owner, wallet: snap.wallet, active: snap.active, holdings, units, balanceUsd, claimableUsd };
}

function fmtUnits(raw: bigint, decimals: number): string {
  const whole = raw / 10n ** BigInt(decimals);
  const frac = raw % 10n ** BigInt(decimals);
  const fracText = frac.toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return fracText ? `${whole}.${fracText}` : whole.toString();
}

const artCache = new Map<number, Uint8Array>();

/** The Broker's 200-byte on-chain bitmap (art is frozen, cached per process). */
export async function readArt(id: number): Promise<Uint8Array | null> {
  const cached = artCache.get(id);
  if (cached) return cached;
  if (!ADDR.renderer || ADDR.renderer === zeroAddress) return null;
  const hex = await publicClient.readContract({ address: ADDR.renderer, abi: rendererAbi, functionName: "bitmapOf", args: [BigInt(id)] });
  const bytes = Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
  if (bytes.length !== ART_BYTES) return null;
  artCache.set(id, bytes);
  return bytes;
}
