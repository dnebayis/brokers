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
  // BadFeed(): the Chainlink staleness guard tripped. Outside market hours the stock
  // feeds stop updating, so this is almost always "the market is closed", not a fault.
  if (/0xb0171a5d|BadFeed/i.test(m))
    return "Stock prices are frozen while the market is closed, so trading is paused. It resumes automatically on the first fresh price after the market opens.";
  return m.length > 160 ? m.slice(0, 160) + "…" : m;
}
