import { createPublicClient, fallback, http } from "viem";
import { activeChain, RPC_HTTP, RPC_PUBLIC_FIRST } from "./chains";

// Two read clients, split by what the call protects:
//  - `client` (metered provider first): wallet-critical paths — pre-transaction reads,
//    receipt waits, ownership discovery. Reliability is worth the quota.
//  - `publicClient` (official endpoint first): ambient reads — metrics, proof panel,
//    leaderboards, valuations. These are the overwhelming bulk of traffic and were
//    draining the metered quota; the free endpoint handles them (CORS *, wide getLogs),
//    with the metered provider left as the fallback rather than the default.
// Both use JSON-RPC + Multicall3 batching to keep call counts low under concurrency.
export const client = createPublicClient({
  chain: activeChain,
  transport: fallback(RPC_HTTP.map((url) => http(url, { batch: { wait: 16 } }))),
  batch: { multicall: { wait: 16 } },
});

export const publicClient = createPublicClient({
  chain: activeChain,
  transport: fallback(RPC_PUBLIC_FIRST.map((url) => http(url, { batch: { wait: 16 } }))),
  batch: { multicall: { wait: 16 } },
});

export async function waitForSuccessfulReceipt(hash: `0x${string}`) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted on-chain.");
  return receipt;
}
