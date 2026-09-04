import type { Address } from "viem";

// Sponsored-campaign config. Deliberately empty until the joint announcement:
// this file ships in the public bundle, so partner names, dollar amounts and the
// campaign wallet stay out of the repo until launch day. Fill in and flip `live`
// in the launch commit.
export const CAMPAIGN: {
  live: boolean;
  partnerName: string; // e.g. the partner collection's public name
  partnerUrl: string;
  wallet: Address | ""; // the campaign wallet holding the sponsored Brokers
  startDate: string; // ISO date, first campaign day
  weeks: number;
  brokerCount: number; // sponsored Brokers expected in the wallet
} = {
  // Live at /campaign but deliberately unlisted: no tab, no nav entry, no link from any
  // other page, so it is reachable by whoever has the URL and invisible to everyone else.
  // The roster and every count come from the chain via the open Broker API, so nothing here
  // needs updating week to week; startDate is the day the desk received its Brokers.
  live: true,
  partnerName: "Geez",
  partnerUrl: "",
  wallet: "0xA7f6e3cBd848a89086d06F507675843F891DB904",
  startDate: "2026-09-04",
  weeks: 4,
  brokerCount: 110,
};

// One row per executed weekly distribution, appended from the batch sender's
// receipts (*.sent.csv). Tx links give the public audit trail.
export type Distribution = {
  week: number;
  date: string; // ISO date the drip ran
  recipients: number;
  totalLabel: string; // human label, e.g. "$625 in PNUTZ"
  receiptsNote?: string; // where the full receipts live (explorer link, csv hash)
};

export const DISTRIBUTIONS: Distribution[] = [];
