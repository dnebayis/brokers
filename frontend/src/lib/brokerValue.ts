"use client";

// Intrinsic backing of a Broker: the real tokenized stock its NFT is worth, priced from
// the same on-chain feeds the Booster uses. Two disjoint parts —
//   pending   = stock the Booster owes the Broker but hasn't moved yet (claimable)
//   inWallet  = stock already claimed into the Broker's ERC-6551 wallet (its TBA)
// so total = pending + inWallet is the hard floor under the NFT: what you'd hold even if
// the collectible were worth nothing. All reads; nothing here sends a transaction.

import { formatUnits, type Address } from "viem";
import { ADDR } from "./config";
import { boosterAbi, brokerAbi, aggregatorAbi, erc20Abi } from "./abis";
import { publicClient as client } from "./client";

const ZERO = "0x0000000000000000000000000000000000000000";

export type TokenMeta = { token: Address; decimals: number; priceUsd: number };

/** Load the Booster's tracked stock tokens once, each with its decimals and USD feed price.
 *  The set is tiny (single digits) and shared across every broker valuation. */
export async function loadKnownTokens(known?: Address[]): Promise<TokenMeta[]> {
  // Callers that already enumerated the Booster's token list pass it in to avoid a
  // second round of the same reads.
  let tokens = known;
  if (!tokens) {
    const count = Number(
      await client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "knownTokenCount" }),
    );
    tokens = (await Promise.all(
      Array.from({ length: count }, (_, i) =>
        client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "knownTokens", args: [BigInt(i)] }),
      ),
    )) as Address[];
  }

  const metas = await Promise.all(
    tokens.map(async (token): Promise<TokenMeta | null> => {
      try {
        const [decimals, feed] = await Promise.all([
          client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
          client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "stockFeed", args: [token] }),
        ]);
        if (!feed || (feed as string) === ZERO) return null;
        const [fdec, rd] = await Promise.all([
          client.readContract({ address: feed as Address, abi: aggregatorAbi, functionName: "decimals" }),
          client.readContract({ address: feed as Address, abi: aggregatorAbi, functionName: "latestRoundData" }),
        ]);
        const priceUsd = Number(formatUnits(rd[1] as bigint, Number(fdec)));
        return { token, decimals: Number(decimals), priceUsd };
      } catch {
        return null;
      }
    }),
  );
  return metas.filter((m): m is TokenMeta => m !== null);
}

function priceOf(metas: TokenMeta[], token: Address): TokenMeta | undefined {
  const lower = token.toLowerCase();
  return metas.find((m) => m.token.toLowerCase() === lower);
}

export type BrokerBacking = { pendingUsd: number; inWalletUsd: number; totalUsd: number };

/** Value one Broker's backing: pending (claimable) + stock already sitting in its TBA. */
export async function brokerBacking(tokenId: bigint, metas: TokenMeta[]): Promise<BrokerBacking> {
  const [claim, tba] = await Promise.all([
    client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "claimable", args: [tokenId] }),
    client.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "accountOf", args: [tokenId] }),
  ]);
  const [tokens, amounts] = claim as readonly [readonly Address[], readonly bigint[]];

  let pendingUsd = 0;
  tokens.forEach((token, i) => {
    const meta = priceOf(metas, token);
    if (!meta) return;
    pendingUsd += Number(formatUnits(amounts[i], meta.decimals)) * meta.priceUsd;
  });

  // Stock already claimed lives as ERC-20 balances at the Broker's token-bound account.
  const balances = await Promise.all(
    metas.map((m) =>
      client
        .readContract({ address: m.token, abi: erc20Abi, functionName: "balanceOf", args: [tba as Address] })
        .catch(() => 0n),
    ),
  );
  let inWalletUsd = 0;
  metas.forEach((m, i) => {
    inWalletUsd += Number(formatUnits(balances[i] as bigint, m.decimals)) * m.priceUsd;
  });

  return { pendingUsd, inWalletUsd, totalUsd: pendingUsd + inWalletUsd };
}

export function usd(n: number): string {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 100 ? 2 : 0 });
}
