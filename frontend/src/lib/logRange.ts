// The public Robinhood Chain RPC answers eth_getLogs for at most 10,000,000 blocks per
// request ("query spans N blocks ... only 10000000 are allowed"). A replay from the Broker
// deployment block passed that span in mid-October 2026 and every full-history read failed.
// Long ranges are therefore read in windows just under the cap, all ending at one pinned head
// so every event type of a replay sees the same chain state.

export const MAX_LOG_SPAN = 9_000_000n;

/** [from, to] windows of at most MAX_LOG_SPAN blocks covering from..to. */
export function logWindows(from: bigint, to: bigint, span: bigint = MAX_LOG_SPAN): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += span) out.push([a, a + span - 1n < to ? a + span - 1n : to]);
  return out;
}

/** Run `read` over every window of from..to (in parallel) and concatenate the results in order. */
export async function readLogWindows<T>(
  from: bigint,
  to: bigint,
  read: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
): Promise<T[]> {
  const parts = await Promise.all(logWindows(from, to).map(([a, b]) => read(a, b)));
  return parts.flat();
}
