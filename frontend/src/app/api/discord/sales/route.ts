// Sales bot sweep: reads Broker Transfer events since the last processed block,
// detects marketplace sales by the Seaport OrderFulfilled logs in each transfer's
// receipt, prices them from the order's own consideration (ETH/WETH), and posts one
// embed per sale to a Discord channel webhook. Driven by a GitHub Actions cron with
// the shared bearer secret; the cursor lives in KV so nothing is ever double-posted.
//
// Detection is deliberately receipt-based, not marketplace-API-based: it works for any
// Seaport frontend (OpenSea or otherwise), needs no API key, and every claim it posts
// is reconstructable from the tx hash it links.

import { NextResponse } from "next/server";
import { formatEther, formatUnits, parseAbiItem, decodeEventLog } from "viem";
import { ADDR } from "@/lib/config";
import { boosterAbi, aggregatorAbi } from "@/lib/abis";
import { env, serverClient, kvGet, kvSet } from "@/lib/discordVerify";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const ORDER_FULFILLED = parseAbiItem(
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)",
);

const CURSOR_KEY = "sales:lastBlock";
const MAX_RANGE = 400_000n;   // bounds one sweep; the cron catches up across runs
const MAX_POSTS = 10;         // per sweep — beyond this, one summary line
const ZERO = "0x0000000000000000000000000000000000000000";
const OS_CHAIN = "robinhood"; // OpenSea's chain identifier (matches their asset URLs)

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// ── OpenSea enrichment (optional — key in env, silently skipped without it) ──
function osKey(): string {
  return process.env.OPENSEA_API_KEY ?? "";
}

async function osFetch(path: string): Promise<Record<string, unknown> | null> {
  if (!osKey()) return null;
  try {
    const res = await fetch(`https://api.opensea.io/api/v2${path}`, {
      headers: { "x-api-key": osKey(), Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Broker artwork URL for the embed thumbnail, cached forever in KV (art is frozen). */
async function brokerImage(id: string): Promise<string | null> {
  const cacheKey = `os:image:${id}`;
  const cached = await kvGet(cacheKey);
  if (cached) return cached === "none" ? null : cached;
  const data = await osFetch(`/chain/${OS_CHAIN}/contract/${ADDR.broker}/nfts/${id}`);
  const url = ((data?.nft as Record<string, unknown> | undefined)?.image_url as string | undefined) ?? null;
  await kvSet(cacheKey, url ?? "none");
  return url;
}

async function collectionFloorEth(): Promise<number | null> {
  const data = await osFetch(`/collections/coattailbrokers/stats`);
  const total = (data?.total as Record<string, unknown> | undefined)?.floor_price;
  return typeof total === "number" && total > 0 ? total : null;
}

async function ethUsd(): Promise<number> {
  try {
    const feed = (await serverClient.readContract({
      address: ADDR.booster, abi: boosterAbi, functionName: "ethUsdFeed",
    })) as `0x${string}`;
    if (!feed || feed === ZERO) return 0;
    const [dec, rd] = await Promise.all([
      serverClient.readContract({ address: feed, abi: aggregatorAbi, functionName: "decimals" }),
      serverClient.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" }),
    ]);
    return Number(formatUnits(rd[1] as bigint, Number(dec)));
  } catch {
    return 0;
  }
}

/** Per-tokenId sale price in ETH-terms, from every OrderFulfilled in the receipt.
 *  Listing fill: our NFT sits in `offer`, payment is the consideration sum.
 *  Bid accept:   our NFT sits in `consideration`, payment is the offer sum. */
function priceByToken(logs: { topics: string[]; data: `0x${string}` }[]): Map<string, number> {
  const prices = new Map<string, number>();
  for (const log of logs) {
    let args;
    try {
      ({ args } = decodeEventLog({
        abi: [ORDER_FULFILLED], data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      }));
    } catch {
      continue;
    }
    const broker = ADDR.broker.toLowerCase();
    const offer = args.offer as readonly { itemType: number; token: string; identifier: bigint; amount: bigint }[];
    const consideration = args.consideration as readonly { itemType: number; token: string; identifier: bigint; amount: bigint }[];
    const isPayment = (i: { itemType: number }) => i.itemType <= 1; // native ETH or ERC-20
    let nfts = offer.filter((i) => i.token.toLowerCase() === broker);
    let payment = consideration.filter(isPayment).reduce((s, i) => s + i.amount, 0n);
    if (nfts.length === 0) {
      nfts = consideration.filter((i) => i.token.toLowerCase() === broker);
      payment = offer.filter(isPayment).reduce((s, i) => s + i.amount, 0n);
    }
    if (nfts.length === 0 || payment === 0n) continue;
    const per = Number(formatEther(payment)) / nfts.length;
    for (const n of nfts) {
      prices.set(n.identifier.toString(), (prices.get(n.identifier.toString()) ?? 0) + per);
    }
  }
  return prices;
}

export async function GET(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (!env.recheckSecret() || auth !== `Bearer ${env.recheckSecret()}`) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const webhook = process.env.SALES_WEBHOOK_URL ?? "";
  if (!webhook) {
    return NextResponse.json({ ok: false, error: "SALES_WEBHOOK_URL not configured" }, { status: 501 });
  }

  const latest = await serverClient.getBlockNumber();
  const stored = await kvGet(CURSOR_KEY);
  // First run starts shallow (~1h of blocks) instead of replaying history.
  let from = stored ? BigInt(stored) + 1n : latest - 40_000n;
  if (latest - from > MAX_RANGE) from = latest - MAX_RANGE;
  if (from > latest) return NextResponse.json({ ok: true, sales: 0, note: "no new blocks" });

  const transfers = await serverClient.getLogs({
    address: ADDR.broker, event: TRANSFER, fromBlock: from, toBlock: latest,
  });
  const moves = transfers.filter((t) => (t.args.from as string).toLowerCase() !== ZERO);

  // One receipt fetch per unique sale tx, shared across its transfers.
  const byTx = new Map<string, typeof moves>();
  for (const t of moves) {
    const list = byTx.get(t.transactionHash!) ?? [];
    list.push(t);
    byTx.set(t.transactionHash!, list as typeof moves);
  }

  const usd = await ethUsd();
  const floor = await collectionFloorEth();
  const embeds: object[] = [];
  let sales = 0;
  for (const [txHash, txTransfers] of byTx) {
    let receipt;
    try {
      receipt = await serverClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
    } catch {
      continue;
    }
    const fulfilled = receipt.logs.filter(
      (l) => l.topics[0] === "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31",
    );
    if (fulfilled.length === 0) continue; // plain wallet move, not a sale
    const prices = priceByToken(fulfilled as never);
    for (const t of txTransfers) {
      const id = (t.args.tokenId as bigint).toString();
      const eth = prices.get(id);
      sales += 1;
      if (embeds.length >= MAX_POSTS) continue;
      const priceLine = eth
        ? `**${eth.toFixed(4)} ETH**${usd ? ` ($${(eth * usd).toFixed(2)})` : ""}`
        : "accepted offer";
      const image = await brokerImage(id);
      embeds.push({
        title: `Broker #${id} sold`,
        description: [
          priceLine,
          `${short(t.args.from as string)} → ${short(t.args.to as string)}`,
          `[tx](https://robinhoodchain.blockscout.com/tx/${txHash}) · [opensea](https://opensea.io/assets/robinhood/${ADDR.broker}/${id})`,
        ].join("\n"),
        ...(image ? { thumbnail: { url: image } } : {}),
        ...(floor ? { footer: { text: `floor ${floor.toFixed(4)} ETH` } } : {}),
        color: 0xa6412f,
      });
    }
  }

  if (embeds.length > 0) {
    if (sales > MAX_POSTS) {
      embeds.push({ description: `…and ${sales - MAX_POSTS} more sales in this window.`, color: 0x4e5666 });
    }
    // Discord caps a message at 10 embeds — send in chunks.
    for (let i = 0; i < embeds.length; i += 10) {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Coattail Sales", embeds: embeds.slice(i, i + 10) }),
      });
      if (!res.ok) {
        // Don't advance the cursor on a failed post — the next sweep retries this window.
        return NextResponse.json({ ok: false, error: `webhook ${res.status}`, sales }, { status: 502 });
      }
    }
  }
  await kvSet(CURSOR_KEY, latest.toString());
  return NextResponse.json({ ok: true, sales, fromBlock: from.toString(), toBlock: latest.toString() });
}
