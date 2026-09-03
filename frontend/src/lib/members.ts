// Member records the indexer publishes every pass (members.json on the data branch):
// one entry per member with filings in the basket window, rows included. Shared by the
// /api/members routes; fetched with a ten-minute cache.

export type MemberRow = {
  symbol: string; type: "buy" | "sell" | "other"; amount: string; notional: number;
  traded: string; filed: string; lagDays: number | null; buyable: boolean; inBasket: boolean;
};
export type MemberRecord = {
  slug: string; name: string; chamber: string; trades: number; buys: number; sells: number;
  buyNotional: number; sellNotional: number; buyableShare: number | null; medianLagDays: number | null;
  lastFiled: string; lastTraded: string;
  topTickers: { symbol: string; notional: number; buyable: boolean }[];
  score: { multiplier: number | null; avgExcess30d: number | null; trades: number | null } | null;
  rows: MemberRow[];
};
export type MembersFile = { generatedAt: string; windowDays: number; members: MemberRecord[] };

export const MEMBERS_REVALIDATE = 600;
const MEMBERS_URL = process.env.MEMBERS_DATA_URL || "https://raw.githubusercontent.com/dnebayis/brokers/data/members.json";

export async function loadMembers(): Promise<MembersFile | null> {
  try {
    const res = await fetch(MEMBERS_URL, { next: { revalidate: MEMBERS_REVALIDATE }, headers: { "User-Agent": "coattail-site/1.0" } });
    if (!res.ok) return null;
    return (await res.json()) as MembersFile;
  } catch {
    return null;
  }
}
