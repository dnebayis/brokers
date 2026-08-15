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
  return m.length > 160 ? m.slice(0, 160) + "…" : m;
}
