// pass.json for a Broker, built from plain values so it can be unit-tested without a chain.
// Store-card style so the front carries a strip image (see strip.ts): Wallet allows one text
// colour per pass, so the coloured numbers are drawn by us; the text fields keep the change
// messages that drive the lock-screen pushes. Every number links back to the chain from the
// back of the card.

export type PassHolding = { symbol: string; formatted: string; usd: number | null };

export type PassIssuer = {
  /** Apple's pass terms require the issuer's name, address and a contact on the pass. */
  name: string;
  address: string;
  email: string;
};

export type PassInput = {
  id: number;
  owner: string; // the owner the pass was issued to
  liveOwner: string; // who owns the Broker right now
  active: boolean;
  wallet: string; // the Broker's ERC-6551 account
  balanceUsd: number | null; // holdings + claimable at feed prices; null = feeds unavailable
  claimableUsd: number | null;
  lastPayoutUsd: number | null; // value of the last observed payout, null = none seen yet
  holdings: PassHolding[]; // wallet + claimable, merged per symbol
  updatedAt: number; // unix seconds
  siteOrigin: string; // https://www.coattail.cash
  explorerBase: string;
  chainId: number;
  passTypeIdentifier: string;
  teamIdentifier: string;
  issuer: PassIssuer;
  /** Present only when the web service is configured; both or neither, per Apple. */
  webService?: { url: string; authenticationToken: string };
};

export const PASS_COLORS = {
  background: "rgb(237, 232, 222)",
  foreground: "rgb(52, 57, 69)",
  label: "rgb(117, 123, 138)",
};

export const usdText = (n: number | null): string => {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

type Field = { key: string; label?: string; value: string; changeMessage?: string; attributedValue?: string };

export function buildPassJson(p: PassInput): Record<string, unknown> {
  const voided = p.liveOwner.toLowerCase() !== p.owner.toLowerCase();
  const symbols = p.holdings.map((h) => h.symbol);
  const top = symbols.slice(0, 3).join(", ") || "none yet";
  const more = symbols.length > 3 ? ` +${symbols.length - 3}` : "";

  const headerFields: Field[] = [
    {
      key: "status",
      label: "STATUS",
      value: voided ? "SOLD" : p.active ? "ACTIVE" : "OFF",
      changeMessage: `broker #${p.id} is now %@`,
    },
  ];
  // The strip image shows the Broker number, the balance and the stocks in colour; these two
  // stay as text under it, and the balance lives on the back so its change message survives.
  const secondaryFields: Field[] = [
    {
      key: "payout",
      label: "LAST PAYOUT",
      value: p.lastPayoutUsd === null ? "—" : `+${usdText(p.lastPayoutUsd)}`,
      changeMessage: "payroll landed: %@",
    },
    { key: "claimable", label: "WAITING IN BOOSTER", value: usdText(p.claimableUsd) },
  ];

  const backFields: Field[] = [
    {
      key: "balance",
      label: "IN THE WALLET",
      value: usdText(p.balanceUsd),
      changeMessage: "balance now %@",
    },
    { key: "stocks", label: "STOCKS", value: `${top}${more}` },
    { key: "broker", label: "BROKER", value: `#${p.id}` },
  ];
  if (voided) {
    backFields.push({
      key: "sold",
      label: "THIS PASS IS NO LONGER YOURS",
      value: `Broker #${p.id} moved to another wallet. The new owner can add their own pass from coattail.cash.`,
    });
  }
  for (const h of p.holdings) {
    backFields.push({
      key: `h-${h.symbol}`,
      label: h.symbol,
      value: h.usd === null ? h.formatted : `${h.formatted} (${usdText(h.usd)})`,
    });
  }
  backFields.push(
    { key: "wallet", label: "BROKER WALLET", value: p.wallet },
    { key: "owner", label: "OWNER", value: p.owner },
    { key: "site", label: "MY BROKERS", value: `${p.siteOrigin}/#activate` },
    { key: "card", label: "PUBLIC CARD", value: `${p.siteOrigin}/card/${p.id}` },
    { key: "explorer", label: "CHECK THE CHAIN", value: `${p.explorerBase}/address/${p.wallet}` },
    {
      key: "how",
      label: "HOW IT WORKS",
      value:
        "the engine buys the disclosed-congress basket with protocol fees and pays every active broker an equal share. " +
        "this card only reads what the chain already says; nothing on it can move funds.",
    },
    { key: "issuer", label: "ISSUED BY", value: p.issuer.name },
    { key: "issuer-address", label: "ADDRESS", value: p.issuer.address },
    { key: "issuer-contact", label: "CONTACT", value: p.issuer.email },
    { key: "updated", label: "LAST UPDATED", value: new Date(p.updatedAt * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" },
  );

  const pass: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: p.passTypeIdentifier,
    teamIdentifier: p.teamIdentifier,
    serialNumber: String(p.id),
    organizationName: p.issuer.name,
    description: `coattail broker #${p.id}`,
    backgroundColor: PASS_COLORS.background,
    foregroundColor: PASS_COLORS.foreground,
    labelColor: PASS_COLORS.label,
    sharingProhibited: true,
    barcodes: [
      {
        format: "PKBarcodeFormatQR",
        message: `${p.siteOrigin}/card/${p.id}`,
        messageEncoding: "iso-8859-1",
        altText: `broker #${p.id}`,
      },
    ],
    storeCard: { headerFields, secondaryFields, backFields },
  };
  if (voided) pass.voided = true;
  if (p.webService) {
    pass.webServiceURL = p.webService.url;
    pass.authenticationToken = p.webService.authenticationToken;
  }
  return pass;
}
