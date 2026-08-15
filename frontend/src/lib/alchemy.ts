import type { Address } from "viem";
import { ALCHEMY_NFT_BASE, ALCHEMY_KEY } from "./chains";

// Enumerate a wallet's Brokers via the Alchemy NFT API (one request, scales to many users) —
// far cheaper than scanning Transfer logs. Throws on any failure so callers can fall back.
export async function alchemyOwnedTokenIds(owner: Address, contract: Address): Promise<bigint[]> {
  if (!ALCHEMY_NFT_BASE || !ALCHEMY_KEY) throw new Error("Alchemy NFT API not configured");
  const ids: bigint[] = [];
  let pageKey: string | undefined;
  for (let i = 0; i < 10; i++) {
    const url = new URL(`${ALCHEMY_NFT_BASE}/${ALCHEMY_KEY}/getNFTsForOwner`);
    url.searchParams.set("owner", owner);
    url.searchParams.append("contractAddresses[]", contract);
    url.searchParams.set("withMetadata", "false");
    url.searchParams.set("pageSize", "100");
    if (pageKey) url.searchParams.set("pageKey", pageKey);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Alchemy NFT API ${res.status}`);
    const json = (await res.json()) as { ownedNfts?: { tokenId: string }[]; pageKey?: string };
    for (const n of json.ownedNfts ?? []) ids.push(BigInt(n.tokenId));
    if (!json.pageKey) break;
    pageKey = json.pageKey;
  }
  return ids;
}
