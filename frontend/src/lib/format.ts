import { formatUnits } from "viem";

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export function fmt(v: bigint | undefined, decimals = 18, precision = 4): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, decimals));
  return n.toLocaleString(undefined, { maximumFractionDigits: precision });
}

export function parseErr(e: unknown): string {
  const any = e as { shortMessage?: string; details?: string; message?: string };
  const m = any?.shortMessage || any?.details || any?.message || String(e);
  if (/user rejected|denied|rejected the request/i.test(m)) return "Cancelled in wallet.";
  if (/insufficient funds/i.test(m)) return "Insufficient ETH for value + gas.";
  // BadFeed(): the Chainlink staleness guard tripped. The window is wide enough to
  // trade straight through weekends at Friday's close, so tripping it means a feed
  // genuinely missed its updates (or an unusually long market holiday).
  if (/0xb0171a5d|BadFeed/i.test(m))
    return "The price feed for a stock in this trade has not updated within the safety window, so the contract refuses to price it. Trading resumes automatically on the next fresh price.";
  return m.length > 160 ? m.slice(0, 160) + "…" : m;
}
