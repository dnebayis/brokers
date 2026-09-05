import { client } from "@/lib/client";
import { coatAbi as erc20AllowanceAbi } from "@/lib/abis";

// Robinhood Chain's public RPC can serve state from a node that has not seen the last
// block yet. Right after an approval is mined that shows up as the OLD allowance: the UI
// concludes the approval is still missing and asks for it again, and a trade simulated
// against that node fails on allowance. Every read that gates on an approval goes through
// here so a lagging node is waited out instead of believed.

export async function readAllowance(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint> {
  return (await client.readContract({ address: token, abi: erc20AllowanceAbi, functionName: "allowance", args: [owner, spender] })) as bigint;
}

/** Poll until the allowance covers `needed` (true) or the wait runs out (false). */
export async function waitForAllowance(
  token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`, needed: bigint,
  { tries = 20, intervalMs = 750 }: { tries?: number; intervalMs?: number } = {},
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await readAllowance(token, owner, spender)) >= needed) return true;
    } catch { /* a failed read is not a missing allowance; keep polling */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Whether `needed` is covered, tolerating a lagging node: a short poll before answering
 * "no", so a just-mined approval is not mistaken for a missing one and re-requested.
 */
export async function hasAllowance(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`, needed: bigint): Promise<boolean> {
  return waitForAllowance(token, owner, spender, needed, { tries: 3, intervalMs: 600 });
}
