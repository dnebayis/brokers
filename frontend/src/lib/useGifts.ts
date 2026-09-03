"use client";

// Gift vault reads. `useGiftFeed` is the public feed (Home): vault state plus every gift
// ever settled, newest first. `useBrokerGifts` is the private view (My Brokers): which
// gifts landed in the visitor's own Brokers and are still sitting in those wallets.

import { useEffect, useState } from "react";
import { ADDR } from "./config";
import { GIFTS, giftVaultAbi, giftsReady, nftAbi } from "./gifts";
import { publicClient as client } from "./client";
import { useStoredQuery } from "./useStoredQuery";

export type Gift = {
  round: number;
  brokerId: string;
  nft: `0x${string}`;
  id: string;
  wallet: `0x${string}`;
  block: number;
  tx: `0x${string}`;
  /** Unix seconds; 0 when the block timestamp could not be read. */
  at: number;
};

export type GiftFeed = {
  lastGiftAt: number;
  interval: number;
  queued: number;
  rounds: number;
  openRound: { nft: `0x${string}`; id: string; drawBlock: number } | null;
  names: Record<string, string>;
  gifts: Gift[];
};

const ZERO = "0x0000000000000000000000000000000000000000";
const GIFTED = giftVaultAbi[0];

/** Name of an NFT collection for display; the Broker collection is named by us. */
async function collectionNames(nfts: `0x${string}`[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const unique = [...new Set(nfts.map((n) => n.toLowerCase() as `0x${string}`))];
  if (unique.length === 0) return out;
  const res = await client.multicall({
    allowFailure: true,
    contracts: unique.map((nft) => ({ address: nft, abi: nftAbi, functionName: "name" as const })),
  });
  unique.forEach((nft, i) => {
    if (nft === ADDR.broker.toLowerCase()) out[nft] = "Coattail Broker";
    else out[nft] = typeof res[i]?.result === "string" ? (res[i]!.result as string) : "NFT";
  });
  return out;
}

async function loadGiftFeed(): Promise<GiftFeed> {
  const vault = GIFTS.vault as `0x${string}`;
  const [lastGiftAt, interval, queued, rounds, open] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: vault, abi: giftVaultAbi, functionName: "lastGiftAt" },
      { address: vault, abi: giftVaultAbi, functionName: "interval" },
      { address: vault, abi: giftVaultAbi, functionName: "queuedCount" },
      { address: vault, abi: giftVaultAbi, functionName: "roundCount" },
      { address: vault, abi: giftVaultAbi, functionName: "open" },
    ],
  });
  const logs = await client.getLogs({ address: vault, event: GIFTED, fromBlock: GIFTS.fromBlock });
  const blocks = [...new Set(logs.map((l) => l.blockNumber))];
  const stamps = new Map<bigint, number>();
  await Promise.all(
    blocks.slice(-40).map(async (bn) => {
      try {
        const b = await client.getBlock({ blockNumber: bn });
        stamps.set(bn, Number(b.timestamp));
      } catch {
        /* leave 0: the row still renders with its tx link */
      }
    }),
  );
  const gifts: Gift[] = logs
    .filter((l) => l.args.brokerId !== undefined && l.args.nft !== undefined)
    .map((l) => ({
      round: Number(l.args.round),
      brokerId: l.args.brokerId!.toString(),
      nft: l.args.nft!,
      id: (l.args.id ?? 0n).toString(),
      wallet: l.args.wallet ?? ZERO,
      block: Number(l.blockNumber),
      tx: l.transactionHash,
      at: stamps.get(l.blockNumber) ?? 0,
    }))
    .reverse();
  const names = await collectionNames([...gifts.map((g) => g.nft), ...(open[0] !== ZERO ? [open[0]] : [])]);
  return {
    lastGiftAt: Number(lastGiftAt),
    interval: Number(interval),
    queued: Number(queued),
    rounds: Number(rounds),
    openRound: open[0] !== ZERO ? { nft: open[0], id: open[1].toString(), drawBlock: Number(open[2]) } : null,
    names,
    gifts,
  };
}

export function useGiftFeed() {
  return useStoredQuery<GiftFeed>({
    storageKey: "coattail.gifts.v1",
    queryKey: ["gift-feed", GIFTS.vault],
    queryFn: loadGiftFeed,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    ssrSafe: true,
  });
}

export type HeldGift = { brokerId: string; nft: `0x${string}`; id: string; name: string; tx: `0x${string}` };

/** Gifts that landed in these Brokers and are still inside their wallets. */
export function useBrokerGifts(brokers: { id: bigint; wallet?: string }[], reloadKey = 0) {
  const [gifts, setGifts] = useState<HeldGift[]>([]);
  const key = brokers.map((b) => `${b.id}:${b.wallet ?? ""}`).join(",");
  useEffect(() => {
    let stale = false;
    const withWallet = brokers.filter((b) => !!b.wallet);
    if (!giftsReady || withWallet.length === 0) {
      setGifts([]);
      return;
    }
    (async () => {
      try {
        const logs = await client.getLogs({
          address: GIFTS.vault as `0x${string}`,
          event: GIFTED,
          args: { brokerId: withWallet.map((b) => b.id) },
          fromBlock: GIFTS.fromBlock,
        });
        if (logs.length === 0) {
          if (!stale) setGifts([]);
          return;
        }
        const owners = await client.multicall({
          allowFailure: true,
          contracts: logs.map((l) => ({
            address: l.args.nft!, abi: nftAbi, functionName: "ownerOf" as const, args: [l.args.id ?? 0n] as const,
          })),
        });
        const names = await collectionNames(logs.map((l) => l.args.nft!));
        const walletOf = new Map(withWallet.map((b) => [b.id.toString(), b.wallet!.toLowerCase()]));
        const held: HeldGift[] = [];
        logs.forEach((l, i) => {
          const owner = owners[i]?.result;
          const brokerId = l.args.brokerId!.toString();
          if (typeof owner !== "string" || owner.toLowerCase() !== walletOf.get(brokerId)) return;
          held.push({
            brokerId, nft: l.args.nft!, id: (l.args.id ?? 0n).toString(),
            name: names[l.args.nft!.toLowerCase()] ?? "NFT", tx: l.transactionHash,
          });
        });
        if (!stale) setGifts(held);
      } catch {
        /* keep the previous list; the next reload retries */
      }
    })();
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reloadKey]);
  return gifts;
}

/** "in 2d 4h" / "any moment" / "when the queue has something" */
export function nextDrawLabel(feed: GiftFeed | undefined, now = Date.now()): string {
  if (!feed) return "…";
  if (feed.openRound) return "drawing now";
  if (feed.queued === 0) return "when the queue has something";
  if (feed.lastGiftAt === 0) return "any moment";
  const at = (feed.lastGiftAt + feed.interval) * 1000;
  const left = at - now;
  if (left <= 0) return "any moment";
  const h = Math.floor(left / 3_600_000);
  const d = Math.floor(h / 24);
  if (d > 0) return `in ${d}d ${h % 24}h`;
  if (h > 0) return `in ${h}h ${Math.floor((left % 3_600_000) / 60_000)}m`;
  return `in ${Math.max(1, Math.floor(left / 60_000))}m`;
}
