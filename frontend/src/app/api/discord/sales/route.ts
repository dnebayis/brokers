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
import { formatEther, formatUnits, parseAbiItem, decodeEventLog, zeroAddress } from "viem";
import { ADDR } from "@/lib/config";
import { boosterAbi, aggregatorAbi } from "@/lib/abis";
import { env, serverClient, kvGet, kvSet } from "@/lib/discordVerify";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const ORDER_FULFILLED = parseAbiItem(
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)",
);

const CURSOR_KEY = "sales:lastBlock";
const MAX_RANGE = 400_000n;   // bounds one sweep; the cron catches up across runs
const MAX_POSTS = 40;         // hard flood guard (a first-run replay); chunked by 10 per message
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

/** Broker artwork URL for the embed thumbnail, cached in KV (art is frozen).
 *  Only a DEFINITIVE answer is cached: a missing key or a failed request must never
 *  poison the cache — v1 of this cached "none" on pre-key sweeps, which is why the key
 *  is versioned. */
async function brokerImage(id: string): Promise<string | null> {
  if (!osKey()) return null;
  const cacheKey = `os:image:v4:${id}`;
  const cached = await kvGet(cacheKey);
  if (cached) return cached === "none" ? null : cached;
  const data = await osFetch(`/chain/${OS_CHAIN}/contract/${ADDR.broker}/nfts/${id}`);
  if (data === null) return null; // request failed — retry on a later sweep
  const nft = data.nft as Record<string, unknown> | undefined;
  // Discord refuses SVG thumbnails and OpenSea never rasterized this on-chain-SVG
  // collection (display_image_url is empty), so an SVG asset is routed through the
  // wsrv.nl image proxy, which converts it to PNG on the fly.
  const candidates = [nft?.display_image_url, nft?.image_url].filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  let url = candidates.find((u) => !u.toLowerCase().endsWith(".svg")) ?? null;
  if (!url) {
    const svg = candidates.find((u) => u.toLowerCase().endsWith(".svg"));
    if (svg) url = `https://wsrv.nl/?url=${encodeURIComponent(svg)}&output=png&w=512`;
  }
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
    if (!feed || feed === zeroAddress) return 0;
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
 *  Bid accept:   our NFT sits in `consideration`, payment is the offer sum.
 *  Matched pair: Seaport's matchOrders flow emits BOTH logs for one sale (buyer order
 *  + seller mirror). Summing them doubled the posted price, so per-side subtotals are
 *  kept apart and a token seen on both sides counts once — the larger side, which is
 *  the full amount the buyer paid including fees. */
function priceByToken(logs: { topics: string[]; data: `0x${string}` }[]): Map<string, number> {
  // token -> per-side accumulated payment (multiple same-side fills are distinct sales)
  const bySide = new Map<string, { offerSide: number; considerationSide: number }>();
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
    let side: "offerSide" | "considerationSide" = "offerSide";
    let nfts = offer.filter((i) => i.token.toLowerCase() === broker);
    let payment = consideration.filter(isPayment).reduce((s, i) => s + i.amount, 0n);
    if (nfts.length === 0) {
      side = "considerationSide";
      nfts = consideration.filter((i) => i.token.toLowerCase() === broker);
      payment = offer.filter(isPayment).reduce((s, i) => s + i.amount, 0n);
    }
    if (nfts.length === 0 || payment === 0n) continue;
    const per = Number(formatEther(payment)) / nfts.length;
    for (const n of nfts) {
      const key = n.identifier.toString();
      const acc = bySide.get(key) ?? { offerSide: 0, considerationSide: 0 };
      acc[side] += per;
      bySide.set(key, acc);
    }
  }
  const prices = new Map<string, number>();
  for (const [key, acc] of bySide) {
    const matchedPair = acc.offerSide > 0 && acc.considerationSide > 0;
    prices.set(key, matchedPair ? Math.max(acc.offerSide, acc.considerationSide) : acc.offerSide + acc.considerationSide);
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

  // Enrichment test hook: ?testId=540 posts one fake-price embed for that token through
  // the exact image/floor path, so OpenSea wiring is verifiable without waiting for a
  // real sale. Cursor untouched.
  // Verify-bot debug hook: ?bioTest=0x… reads that wallet's OpenSea bio through the
  // exact same call the verify flow uses, so a "can't verify" report is diagnosable
  // without a real Discord state. Bearer-protected like everything else here.
  const bioTest = new URL(request.url).searchParams.get("bioTest");
  if (bioTest) {
    const { openseaBio } = await import("@/lib/discordVerify");
    const bio = await openseaBio(bioTest);
    return NextResponse.json({ ok: true, bioTest, hasKey: !!osKey(), bio: bio === null ? "NULL (fetch failed)" : bio });
  }

  const testId = new URL(request.url).searchParams.get("testId");
  if (testId) {
    const [image, floor, usdNow] = await Promise.all([brokerImage(testId), collectionFloorEth(), ethUsd()]);
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Coattail Sales",
        embeds: [{
          title: `TEST — Broker #${testId}`,
          description: "enrichment test post — not a real sale",
          ...(image ? { thumbnail: { url: image } } : {}),
          ...(floor ? { footer: { text: `floor ${floor.toFixed(4)} ETH${usdNow ? ` ($${(floor * usdNow).toFixed(2)})` : ""}` } } : {}),
          color: 0x757b8a,
        }],
      }),
    });
    return NextResponse.json({
      ok: res.ok, test: true, hasKey: !!osKey(), image: image ?? "none", floor: floor ?? "none",
    });
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
  const moves = transfers.filter((t) => (t.args.from as string).toLowerCase() !== zeroAddress);

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
