import type { Address } from "viem";

// Sponsored-campaign config. The Geez x Coattail desk is public on both sides now, so its
// public facts (partner, campaign page, wallet, calendar) are committed as defaults; the
// Vercel env variables below still override every one of them, which is how the next
// campaign goes live without a commit, and how this one can be paused (LIVE=0).
//
//   NEXT_PUBLIC_CAMPAIGN_LIVE=0|1
//   NEXT_PUBLIC_CAMPAIGN_PARTNER="Partner name"
//   NEXT_PUBLIC_CAMPAIGN_PARTNER_URL=https://...   (their campaign page)
//   NEXT_PUBLIC_CAMPAIGN_WALLET=0x...              (the wallet holding the sponsored Brokers)
//   NEXT_PUBLIC_CAMPAIGN_START=2026-01-01          (ISO date, first campaign day, UTC)
//   NEXT_PUBLIC_CAMPAIGN_WEEKS=4
//   NEXT_PUBLIC_CAMPAIGN_SEATS=100                 (seats offered to participants)
//
// Next inlines only literal `process.env.X` reads, so each one is spelled out.
const DEFAULTS = {
  live: "1",
  partner: "Geez",
  partnerUrl: "https://www.geezonape.com/campaign?id=6f6e543d-9b74-4398-805c-11e37f13bdc3",
  wallet: "0xA7f6e3cBd848a89086d06F507675843F891DB904",
  start: "2026-09-06",
  weeks: "4",
  seats: "100",
};
const env = (v: string | undefined, fallback: string) => {
  const t = (v ?? "").trim();
  return t === "" ? fallback : t;
};
const partner = env(process.env.NEXT_PUBLIC_CAMPAIGN_PARTNER, DEFAULTS.partner);
const partnerUrl = env(process.env.NEXT_PUBLIC_CAMPAIGN_PARTNER_URL, DEFAULTS.partnerUrl);
const walletEnv = env(process.env.NEXT_PUBLIC_CAMPAIGN_WALLET, DEFAULTS.wallet);
const startDate = env(process.env.NEXT_PUBLIC_CAMPAIGN_START, DEFAULTS.start);
const weeksEnv = env(process.env.NEXT_PUBLIC_CAMPAIGN_WEEKS, DEFAULTS.weeks);
const seatsEnv = env(process.env.NEXT_PUBLIC_CAMPAIGN_SEATS ?? process.env.NEXT_PUBLIC_CAMPAIGN_BROKERS, DEFAULTS.seats);
const liveEnv = env(process.env.NEXT_PUBLIC_CAMPAIGN_LIVE, DEFAULTS.live);

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
  seats: number;
  /** First day after the campaign (ISO date), derived from start + weeks. */
  endDate: string;
} = {
  live: liveEnv === "1" && wallet !== "",
  partnerName: partner,
  partnerUrl,
  wallet,
  startDate,
  weeks: positive(weeksEnv, 4),
  seats: positive(seatsEnv, 0),
  endDate: (() => {
    const t = Date.parse(`${startDate}T00:00:00Z`);
    if (!Number.isFinite(t)) return "";
    return new Date(t + positive(weeksEnv, 4) * 7 * 86_400_000).toISOString().slice(0, 10);
  })(),
};
