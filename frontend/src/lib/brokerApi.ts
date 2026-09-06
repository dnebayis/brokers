import { getAddress, isAddress, type Address } from "viem";
import { ADDR, BROKER_DEPLOYMENT_BLOCK } from "./config";
import { brokerAbi, boosterAbi, erc20Abi } from "./abis";
import { alchemyOwnedTokenIds } from "@/lib/alchemy";
import { publicClient } from "./client";

// Server-side reads behind the public Broker API (/api/broker/[id],
// /api/wallet/[address]/brokers). Everything here is re-derivable by anyone from the
// verified contracts — the API only saves integrators the ABI work, so it needs no keys.

export type TokenAmount = {
  token: Address;
  symbol: string;
  decimals: number;
  amount: string; // raw units as decimal string (JSON has no bigint)
  formatted: string;
};

export type BrokerSnapshot = {
  id: number;
  owner: Address;
  wallet: Address; // the Broker's ERC-6551 account — where salaries land
  active: boolean;
  claimable: TokenAmount[]; // accrued in the Booster, not yet pulled to the wallet
  holdings: TokenAmount[]; // balances already sitting in the wallet
};

// symbol/decimals are immutable per token — cache for the life of the server process.
const tokenMetaCache = new Map<string, { symbol: string; decimals: number }>();

async function tokenMeta(tokens: Address[]): Promise<Map<string, { symbol: string; decimals: number }>> {
  const missing = tokens.filter((t) => !tokenMetaCache.has(t.toLowerCase()));
  if (missing.length > 0) {
    const results = await publicClient.multicall({
      contracts: missing.flatMap((token) => [
        { address: token, abi: erc20Abi, functionName: "symbol" } as const,
        { address: token, abi: erc20Abi, functionName: "decimals" } as const,
      ]),
      allowFailure: true,
    });
    missing.forEach((token, i) => {
      tokenMetaCache.set(token.toLowerCase(), {
        symbol: (results[i * 2]?.result as string | undefined) ?? "???",
        decimals: (results[i * 2 + 1]?.result as number | undefined) ?? 18,
      });
    });
  }
  return tokenMetaCache;
}

function toAmounts(
  tokens: Address[],
  amounts: bigint[],
  meta: Map<string, { symbol: string; decimals: number }>,
): TokenAmount[] {
  return tokens
    .map((token, i) => ({ token, raw: amounts[i] ?? 0n }))
    .filter((entry) => entry.raw > 0n)
    .map((entry) => {
      const m = meta.get(entry.token.toLowerCase()) ?? { symbol: "???", decimals: 18 };
      const whole = entry.raw / 10n ** BigInt(m.decimals);
      const frac = entry.raw % 10n ** BigInt(m.decimals);
      const fracText = frac.toString().padStart(m.decimals, "0").slice(0, 6).replace(/0+$/, "");
      return {
        token: entry.token,
        symbol: m.symbol,
        decimals: m.decimals,
        amount: entry.raw.toString(),
        formatted: fracText ? `${whole}.${fracText}` : whole.toString(),
      };
    });
}

async function boosterTokenList(): Promise<Address[]> {
  const count = Number(
    await publicClient.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "knownTokenCount" }),
  );
  if (count === 0) return [];
  const results = await publicClient.multicall({
    contracts: Array.from({ length: count }, (_, i) => ({
      address: ADDR.booster, abi: boosterAbi, functionName: "knownTokens", args: [BigInt(i)],
    } as const)),
    allowFailure: true,
  });
  return results.map((r) => r.result as Address | undefined).filter((a): a is Address => !!a);
}

export async function brokerSnapshot(id: number): Promise<BrokerSnapshot | null> {
  const tokenId = BigInt(id);
  const [core, tokens] = await Promise.all([
    publicClient.multicall({
      contracts: [
        { address: ADDR.broker, abi: brokerAbi, functionName: "ownerOf", args: [tokenId] } as const,
        { address: ADDR.broker, abi: brokerAbi, functionName: "accountOf", args: [tokenId] } as const,
        { address: ADDR.broker, abi: brokerAbi, functionName: "activated", args: [tokenId] } as const,
        { address: ADDR.booster, abi: boosterAbi, functionName: "claimable", args: [tokenId] } as const,
      ],
      allowFailure: true,
    }),
    boosterTokenList(),
  ]);

  const owner = core[0]?.result as Address | undefined;
  const wallet = core[1]?.result as Address | undefined;
  if (!owner || !wallet) return null; // nonexistent token — ownerOf reverted

  const claimableResult = core[3]?.result as readonly [readonly Address[], readonly bigint[]] | undefined;
  const claimTokens = claimableResult ? [...claimableResult[0]] : [];
  const claimAmounts = claimableResult ? [...claimableResult[1]] : [];

  // Wallet holdings: every Booster-known stock plus $COAT.
  const holdingTokens = [...new Set([...tokens, ADDR.coat].map((t) => t.toLowerCase()))].map(
    (t) => getAddress(t),
  );
  const balances = await publicClient.multicall({
    contracts: holdingTokens.map((token) => ({
      address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet],
    } as const)),
    allowFailure: true,
  });
  const holdingAmounts = balances.map((r) => (r.result as bigint | undefined) ?? 0n);

  const meta = await tokenMeta([...new Set([...claimTokens, ...holdingTokens].map((t) => t.toLowerCase()))].map((t) => t as Address));

  return {
    id,
    owner,
    wallet,
    active: !!(core[2]?.result as boolean | undefined),
    claimable: toAmounts(claimTokens, claimAmounts, meta),
    holdings: toAmounts(holdingTokens, holdingAmounts, meta),
  };
}

export type OwnedBrokerRow = { id: number; active: boolean; wallet: Address };

// A wallet's Brokers, server-side. Candidate ids come from the cheapest source that answers:
// the Alchemy NFT API (one HTTP call, no RPC), then inbound Transfer logs, then the whole
// 1..MAX_SUPPLY domain (random mint scatters ids across it). ownerOf confirms each one.
// Reads go out in small multicalls, and the ids a chunk failed to answer are retried on
// their own before the read is declared short: a dropped chunk must never turn into a
// roster that is quietly missing Brokers, nor into a needless full scan.
const RESOLVE_CHUNK = 40;

export async function walletBrokers(address: string): Promise<OwnedBrokerRow[] | null> {
  if (!isAddress(address)) return null;
  const ownerKey = address.toLowerCase();

  const expected = Number(
    await publicClient.readContract({
      address: ADDR.broker, abi: brokerAbi, functionName: "balanceOf", args: [address],
    }),
  );
  if (expected === 0) return [];

  const resolveOnce = async (ids: bigint[]): Promise<{ rows: OwnedBrokerRow[]; unanswered: bigint[] }> => {
    const rows: OwnedBrokerRow[] = [];
    const unanswered: bigint[] = [];
    for (let offset = 0; offset < ids.length; offset += RESOLVE_CHUNK) {
      const batch = ids.slice(offset, offset + RESOLVE_CHUNK);
      type Cell = { result?: unknown; status: "success" | "failure" };
      let results: readonly Cell[];
      try {
        results = (await publicClient.multicall({
          contracts: batch.flatMap((id) => [
            { address: ADDR.broker, abi: brokerAbi, functionName: "ownerOf", args: [id] } as const,
            { address: ADDR.broker, abi: brokerAbi, functionName: "activated", args: [id] } as const,
            { address: ADDR.broker, abi: brokerAbi, functionName: "accountOf", args: [id] } as const,
          ]),
          allowFailure: true,
        })) as readonly Cell[];
      } catch {
        unanswered.push(...batch);
        continue;
      }
      batch.forEach((id, i) => {
        const owner = results![i * 3]?.result as string | undefined;
        const wallet = results![i * 3 + 2]?.result as Address | undefined;
        if (owner === undefined || wallet === undefined) { unanswered.push(id); return; }
        if (owner.toLowerCase() === ownerKey) {
          rows.push({ id: Number(id), active: !!(results![i * 3 + 1]?.result as boolean | undefined), wallet });
        }
      });
    }
    return { rows, unanswered };
  };

  // Resolve, then retry whatever went unanswered (a burned or nonexistent id reverts on
  // ownerOf and is simply not ours; a chunk the RPC dropped comes back on the second try).
  const resolve = async (ids: bigint[]): Promise<OwnedBrokerRow[]> => {
    const first = await resolveOnce(ids);
    if (first.unanswered.length === 0) return first.rows;
    await new Promise((r) => setTimeout(r, 400));
    const second = await resolveOnce(first.unanswered);
    return [...first.rows, ...second.rows];
  };

  // Phase timings go to the server log: the read has three very different cost paths and
  // "the API is slow" is only diagnosable if the log says which one ran.
  const t0 = Date.now();
  const mark = (what: string) => console.info(`wallet api: ${what} at +${Date.now() - t0}ms`);
  let candidateIds: bigint[] = [];
  try {
    candidateIds = await alchemyOwnedTokenIds(address as Address, ADDR.broker as Address);
    mark(`nft api gave ${candidateIds.length} candidates`);
  } catch (err) {
    mark(`nft api failed (${String(err).slice(0, 80)}), scanning transfer logs`);
    try {
      const inbound = await publicClient.getLogs({
        address: ADDR.broker,
        event: brokerAbi[0],
        args: { to: address },
        fromBlock: BROKER_DEPLOYMENT_BLOCK,
      });
      candidateIds = [...new Set(inbound.map((log) => log.args.tokenId).filter((id): id is bigint => id !== undefined))];
      mark(`transfer logs gave ${candidateIds.length} candidates`);
    } catch (err) {
      mark(`transfer logs failed (${String(err).slice(0, 80)})`);
      candidateIds = [];
    }
  }

  let owned = candidateIds.length > 0 ? await resolve(candidateIds) : [];
  mark(`resolved ${owned.length} of ${expected} from candidates`);
  if (owned.length < expected) {
    const maxSupply = Number(
      await publicClient.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "MAX_SUPPLY" }),
    );
    owned = await resolve(Array.from({ length: maxSupply }, (_, i) => BigInt(i + 1)));
    mark(`full scan resolved ${owned.length} of ${expected}`);
  }
  // The chain says the wallet holds `expected` Brokers. Returning fewer is not an answer, it
  // is a read that failed part-way; served with a 200 it would be cached at the edge as the
  // truth for an hour. Failing loudly turns it into a 502 that nothing caches.
  if (owned.length < expected) {
    throw new Error(`incomplete roster: resolved ${owned.length} of ${expected}`);
  }
  return owned.sort((a, b) => a.id - b.id);
}
