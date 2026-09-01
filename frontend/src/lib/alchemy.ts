import type { Address } from "viem";
import { ALCHEMY_NFT_BASE, ALCHEMY_KEY } from "./chains";

const MAX_PAGES = 10; // 1,000 Brokers; more than any single wallet holds of a 1,776 collection

async function fetchPage(url: string): Promise<Response> {
  // One retry on the transient classes only: a single 429/5xx used to throw straight
  // through and push the caller onto the far costlier Transfer-log scan.
  const res = await fetch(url);
  if (res.ok || (res.status < 500 && res.status !== 429)) return res;
  await new Promise((r) => setTimeout(r, 800));
  return fetch(url);
}

// Enumerate a wallet's Brokers via the Alchemy NFT API (one request, scales to many users) —
// far cheaper than scanning Transfer logs. Throws on any failure so callers can fall back.
export async function alchemyOwnedTokenIds(owner: Address, contract: Address): Promise<bigint[]> {
  if (!ALCHEMY_NFT_BASE || !ALCHEMY_KEY) throw new Error("Alchemy NFT API not configured");
  const ids: bigint[] = [];
  let pageKey: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(`${ALCHEMY_NFT_BASE}/${ALCHEMY_KEY}/getNFTsForOwner`);
    url.searchParams.set("owner", owner);
    url.searchParams.append("contractAddresses[]", contract);
    url.searchParams.set("withMetadata", "false");
    url.searchParams.set("pageSize", "100");
    if (pageKey) url.searchParams.set("pageKey", pageKey);
    const res = await fetchPage(url.toString());
    if (!res.ok) throw new Error(`Alchemy NFT API ${res.status}`);
    const json = (await res.json()) as { ownedNfts?: { tokenId: string }[]; pageKey?: string };
    for (const n of json.ownedNfts ?? []) ids.push(BigInt(n.tokenId));
    if (!json.pageKey) break;
    pageKey = json.pageKey;
    if (i === MAX_PAGES - 1) throw new Error("Alchemy NFT API: page cap reached, result would be truncated");
  }
  return ids;
}
