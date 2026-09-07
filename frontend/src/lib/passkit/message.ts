// The message a holder signs to prove they want a pass for this Broker. Shared by the browser
// (which asks the wallet to sign it) and the server (which verifies it), so it lives in a file
// with no node-only imports. Human-readable on purpose: a wallet shows it verbatim, and it
// names the site, the Broker, the wallet, the chain and an expiry, so a signature can't be
// replayed for a different Broker or later.

export function issueMessage(input: { id: number; address: string; chainId: number; expiresAt: string }): string {
  return [
    `coattail.cash wants to add Broker #${input.id} to your Apple Wallet.`,
    "",
    `wallet: ${input.address}`,
    `broker: ${input.id}`,
    `chain: ${input.chainId}`,
    `expires: ${input.expiresAt}`,
  ].join("\n");
}

/** How long a signed issue request stays valid (the wallet prompt plus a slow network). */
export const ISSUE_WINDOW_MS = 15 * 60 * 1000;

export function issueExpiryValid(expiresAt: string, nowMs = Date.now()): boolean {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return false;
  // not yet expired, and not asking for an absurdly long window
  return t > nowMs && t - nowMs <= ISSUE_WINDOW_MS;
}
