// Pure state transition for a pass record: given what the card showed last time and what the
// chain says now, decide whether the card changed and what "last payout" should read.
// Payouts are detected as growth in token UNITS (wallet + claimable), so a price swing never
// pings anyone as a payday; its dollar value is taken at today's prices.

export type RecordState = {
  owner: string; // lowercase
  active: boolean;
  units: Record<string, string>;
  balanceUsd: number | null;
  claimableUsd: number | null;
  lastPayoutUsd: number | null;
  voided: boolean;
  updatedAt: number;
};

export type LiveState = {
  liveOwner: string;
  active: boolean;
  units: Record<string, string>;
  holdings: { symbol: string; usd: number | null; units: string }[];
  balanceUsd: number | null;
  claimableUsd: number | null;
};

/** Value of the units that appeared since `prevUnits`, at current prices (per-symbol). */
export function payoutValue(prevUnits: Record<string, string>, live: LiveState): number | null {
  let total = 0;
  let any = false;
  for (const h of live.holdings) {
    const before = BigInt(prevUnits[h.symbol] ?? "0");
    const now = BigInt(h.units);
    if (now <= before) continue;
    any = true;
    if (h.usd === null || now === 0n) continue;
    total += Number(((now - before) * 10_000n) / now) / 10_000 * h.usd;
  }
  return any ? total : null;
}

const cents = (n: number | null) => (n === null ? null : Math.round(n * 100));
export const DRIFT_REFRESH_SEC = 3600;
/** Reasons worth a push (a phone ping): everything except a silent price drift refresh. */
export const pushWorthy = (reasons: string[]): boolean => reasons.some((r) => r !== "drift");

export function advance(prev: RecordState, live: LiveState, now: number): { next: RecordState; changed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const voided = live.liveOwner.toLowerCase() !== prev.owner;
  if (voided !== prev.voided) reasons.push(voided ? "sold" : "owner-again");
  if (!voided && live.active !== prev.active) reasons.push(live.active ? "switched-on" : "switched-off");

  let lastPayoutUsd = prev.lastPayoutUsd;
  if (!voided) {
    const paid = payoutValue(prev.units, live);
    if (paid !== null) {
      reasons.push("payout");
      lastPayoutUsd = paid;
    }
  }
  // A price move is not an event: it must not push the phone (a push per tick got Wallet
  // throttling us) and must not move Last-Modified on every fetch. The numbers still refresh
  // silently, at most once an hour, so a manual pull shows something current.
  const balanceMoved = !voided && cents(live.balanceUsd) !== cents(prev.balanceUsd);
  if (balanceMoved && reasons.length === 0 && now - prev.updatedAt >= DRIFT_REFRESH_SEC) reasons.push("drift");

  const changed = reasons.length > 0;
  const next: RecordState = {
    owner: prev.owner,
    active: live.active,
    units: voided ? prev.units : live.units,
    balanceUsd: live.balanceUsd,
    claimableUsd: live.claimableUsd,
    lastPayoutUsd,
    voided,
    updatedAt: changed ? now : prev.updatedAt,
  };
  return { next, changed, reasons };
}
