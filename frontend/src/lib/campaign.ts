import type { Address } from "viem";

// Sponsored-campaign config, read from build-time env rather than committed here.
// The repo is public, so a partner's name, wallet and calendar would be readable the moment
// they landed in a commit. Keeping them in Vercel env means the page goes live by setting
// variables and nothing partner-specific sits in git.
//
// Set on the Vercel project (Production), then redeploy:
//   NEXT_PUBLIC_CAMPAIGN_LIVE=1
//   NEXT_PUBLIC_CAMPAIGN_PARTNER="Partner name"
//   NEXT_PUBLIC_CAMPAIGN_PARTNER_URL=https://x.com/partner   (optional)
//   NEXT_PUBLIC_CAMPAIGN_WALLET=0x...            (the wallet holding the sponsored Brokers)
//   NEXT_PUBLIC_CAMPAIGN_START=2026-01-01        (ISO date, first campaign day)
//   NEXT_PUBLIC_CAMPAIGN_WEEKS=4
//   NEXT_PUBLIC_CAMPAIGN_BROKERS=100
//
// Next inlines only literal `process.env.X` reads, so each one is spelled out.
const partner = (process.env.NEXT_PUBLIC_CAMPAIGN_PARTNER ?? "").trim();
const partnerUrl = (process.env.NEXT_PUBLIC_CAMPAIGN_PARTNER_URL ?? "").trim();
const walletEnv = (process.env.NEXT_PUBLIC_CAMPAIGN_WALLET ?? "").trim();
const startDate = (process.env.NEXT_PUBLIC_CAMPAIGN_START ?? "").trim();
const weeksEnv = (process.env.NEXT_PUBLIC_CAMPAIGN_WEEKS ?? "").trim();
const brokersEnv = (process.env.NEXT_PUBLIC_CAMPAIGN_BROKERS ?? "").trim();
const liveEnv = (process.env.NEXT_PUBLIC_CAMPAIGN_LIVE ?? "").trim();

// A half-set config must not half-render the page: live needs the flag AND a usable wallet,
// since every number on the page is derived from that wallet's roster.
const wallet = /^0x[0-9a-fA-F]{40}$/.test(walletEnv) ? (walletEnv as Address) : "";
const positive = (text: string, fallback: number) => {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const CAMPAIGN: {
  live: boolean;
  partnerName: string;
  partnerUrl: string;
  wallet: Address | "";
  startDate: string;
  weeks: number;
  brokerCount: number;
} = {
  live: liveEnv === "1" && wallet !== "",
  partnerName: partner,
  partnerUrl,
  wallet,
  startDate,
  weeks: positive(weeksEnv, 4),
  brokerCount: positive(brokersEnv, 0),
};

// One row per executed weekly distribution, appended from the batch sender's receipts
// (*.sent.csv) once a drip has run and is public. Tx links give the audit trail.
export type Distribution = {
  week: number;
  date: string; // ISO date the drip ran
  recipients: number;
  totalLabel: string; // human label, e.g. "week one drip"
  receiptsNote?: string; // where the full receipts live (explorer link, csv hash)
};

export const DISTRIBUTIONS: Distribution[] = [];
