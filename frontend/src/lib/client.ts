import { createPublicClient, fallback, http } from "viem";
import { activeChain, RPC_HTTP } from "./chains";

// Standalone viem client for imperative reads / quotes / receipt waits, independent of wallet
// state. JSON-RPC batching + Multicall3 batching keep RPC load low under heavy concurrency.
export const client = createPublicClient({
  chain: activeChain,
  transport: fallback(RPC_HTTP.map((url) => http(url, { batch: { wait: 16 } }))),
  batch: { multicall: { wait: 16 } },
});

export async function waitForSuccessfulReceipt(hash: `0x${string}`) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted on-chain.");
  return receipt;
}
