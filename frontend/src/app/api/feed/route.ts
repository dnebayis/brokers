import { NextResponse } from "next/server";

// Server-only Congress disclosure feed. Prefer Unusual Whales' normalized
// Congress endpoint; retain FMP as a fallback. Never silently replace an
// upstream failure with fake rows—the UI must distinguish live from unavailable.
//
// Cached for one hour. This response is what every visitor's Feed tab reads, and the
// upstream Unusual Whales call only fires when this cache is stale — so the TTL, not
// visitor traffic, sets how often we spend the API quota. Disclosures update slowly
// (members file with a ~45-day lag), so hourly is fresh enough and keeps the key cheap.
export const revalidate = 3600;

type FeedItem = {
  chamber: "House" | "Senate";
  member: string;
  symbol: string;
  type: "buy" | "sell" | "other";
  amount: string;
  transactionDate: string;
  disclosureDate: string;
};

type FeedResponse = {
  live: boolean;
  source: "unusual_whales" | "fmp" | "none";
  status: "ok" | "unconfigured" | "upstream_error" | "empty";
  items: FeedItem[];
};

function normType(value: unknown): FeedItem["type"] {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("purchase") || text.includes("buy")) return "buy";
  if (text.includes("sale") || text.includes("sell")) return "sell";
  return "other";
}

function normChamber(value: unknown, fallback: FeedItem["chamber"]): FeedItem["chamber"] {
  return String(value ?? "").toLowerCase().includes("senate") ? "Senate" : fallback;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapFmp(rows: any[], chamber: FeedItem["chamber"]): FeedItem[] {
  return rows.map((row) => ({
    chamber,
    member:
      row.representative ||
      row.office ||
      [row.firstName, row.lastName].filter(Boolean).join(" ") ||
      "Unknown member",
    symbol: String(row.symbol || row.ticker || "").toUpperCase(),
    type: normType(row.type),
    amount: String(row.amount || ""),
    transactionDate: String(row.transactionDate || row.date || "").slice(0, 10),
    disclosureDate: String(row.disclosureDate || "").slice(0, 10),
  }));
}

function mapUw(rows: any[]): FeedItem[] {
  return rows.map((row) => ({
    chamber: normChamber(row.member_type, "House"),
    member: String(row.name || row.reporter || "Unknown member"),
    symbol: String(row.ticker || "").toUpperCase(),
    type: normType(row.txn_type),
    amount: String(row.amounts || ""),
    transactionDate: String(row.transaction_date || "").slice(0, 10),
    disclosureDate: String(row.filed_at_date || "").slice(0, 10),
  }));
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, next: { revalidate } });
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  return response.json();
}

function finish(source: FeedResponse["source"], items: FeedItem[]): FeedResponse {
  const clean = items
    .filter((item) => item.symbol)
    .sort((a, b) => b.disclosureDate.localeCompare(a.disclosureDate))
    .slice(0, 100);
  return { live: clean.length > 0, source, status: clean.length ? "ok" : "empty", items: clean };
}

export async function GET() {
  const unusualWhalesKey = process.env.UNUSUAL_WHALES_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;

  try {
    if (unusualWhalesKey) {
      const payload = (await fetchJson(
        "https://api.unusualwhales.com/api/politician-portfolios/recent_trades?limit=100&page=1",
        { headers: { Authorization: `Bearer ${unusualWhalesKey}`, Accept: "application/json" } },
      )) as { data?: any[] };
      return NextResponse.json(finish("unusual_whales", mapUw(payload.data ?? [])));
    }

    if (fmpKey) {
      const base = "https://financialmodelingprep.com/stable";
      const [house, senate] = await Promise.all([
        fetchJson(`${base}/house-latest?page=0&limit=100&apikey=${encodeURIComponent(fmpKey)}`),
        fetchJson(`${base}/senate-latest?page=0&limit=100&apikey=${encodeURIComponent(fmpKey)}`),
      ]);
      return NextResponse.json(
        finish("fmp", [
          ...mapFmp(Array.isArray(house) ? house : [], "House"),
          ...mapFmp(Array.isArray(senate) ? senate : [], "Senate"),
        ]),
      );
    }

    return NextResponse.json<FeedResponse>({
      live: false,
      source: "none",
      status: "unconfigured",
      items: [],
    });
  } catch {
    return NextResponse.json<FeedResponse>(
      { live: false, source: unusualWhalesKey ? "unusual_whales" : "fmp", status: "upstream_error", items: [] },
      { status: 502 },
    );
  }
}
