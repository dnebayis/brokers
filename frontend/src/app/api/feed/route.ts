import { NextResponse } from "next/server";

// The Feed tab's rows. Primary source: the indexer's 30-day export on the repository's
// data branch (the same filings the basket is built from, with member slugs and
// buyable / in-basket flags). Fallback when that file is unreachable: the provider's
// first page (Unusual Whales, then FMP), which is what this route served before.
// Cached for ten minutes; the export refreshes every indexer pass.
export const revalidate = 600;

const FEED_URL = process.env.FEED_DATA_URL || "https://raw.githubusercontent.com/dnebayis/brokers/data/feed-30d.json";

export type FeedItem = {
  chamber: "House" | "Senate";
  member: string;
  slug?: string;
  symbol: string;
  type: "buy" | "sell" | "other";
  amount: string;
  transactionDate: string;
  disclosureDate: string;
  lagDays?: number | null;
  buyable?: boolean;
  inBasket?: boolean;
};

type FeedResponse = {
  live: boolean;
  source: "indexer" | "unusual_whales" | "fmp" | "none";
  status: "ok" | "unconfigured" | "upstream_error" | "empty";
  days?: number;
  generatedAt?: string;
  items: FeedItem[];
};

function normType(value: unknown): FeedItem["type"] {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("purchase") || text.includes("buy")) return "buy";
  if (text.includes("sale") || text.includes("sell")) return "sell";
  return "other";
}

function normChamber(value: unknown, fallback: FeedItem["chamber"]): FeedItem["chamber"] {
  return String(value ?? "").toLowerCase().includes("senat") ? "Senate" : fallback;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapExport(rows: any[]): FeedItem[] {
  return rows.map((r) => ({
    chamber: normChamber(r.chamber, "House"),
    member: String(r.member || "Unknown member"),
    slug: String(r.slug || ""),
    symbol: String(r.symbol || "").toUpperCase(),
    type: (r.type === "buy" || r.type === "sell" ? r.type : "other") as FeedItem["type"],
    amount: String(r.amount || ""),
    transactionDate: String(r.traded || "").slice(0, 10),
    disclosureDate: String(r.filed || "").slice(0, 10),
    lagDays: typeof r.lagDays === "number" ? r.lagDays : null,
    buyable: !!r.buyable,
    inBasket: !!r.inBasket,
  }));
}

function mapFmp(rows: any[], chamber: FeedItem["chamber"]): FeedItem[] {
  return rows.map((row) => ({
    chamber,
    member: row.representative || row.office || [row.firstName, row.lastName].filter(Boolean).join(" ") || "Unknown member",
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

function finish(source: FeedResponse["source"], items: FeedItem[], extra: Partial<FeedResponse> = {}): FeedResponse {
  const clean = items.filter((item) => item.symbol).sort((a, b) => b.disclosureDate.localeCompare(a.disclosureDate));
  return { live: clean.length > 0, source, status: clean.length ? "ok" : "empty", items: clean, ...extra };
}

export async function GET() {
  try {
    const exp = (await fetchJson(FEED_URL, { headers: { "User-Agent": "coattail-site/1.0" } })) as { rows?: any[]; days?: number; generatedAt?: string };
    if (Array.isArray(exp.rows) && exp.rows.length > 0) {
      return NextResponse.json(finish("indexer", mapExport(exp.rows), { days: exp.days ?? 30, generatedAt: exp.generatedAt }));
    }
  } catch (err) {
    console.warn("feed: indexer export unavailable, falling back to provider:", String(err));
  }

  const unusualWhalesKey = process.env.UNUSUAL_WHALES_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;
  try {
    if (unusualWhalesKey) {
      try {
        const payload = (await fetchJson(
          "https://api.unusualwhales.com/api/politician-portfolios/recent_trades?limit=100&page=1",
          { headers: { Authorization: `Bearer ${unusualWhalesKey}`, Accept: "application/json" } },
        )) as { data?: any[] };
        return NextResponse.json(finish("unusual_whales", mapUw(payload.data ?? [])));
      } catch (err) {
        if (!fmpKey) throw err;
        console.warn("feed: unusual_whales failed, falling back to fmp:", String(err));
      }
    }
    if (fmpKey) {
      const base = "https://financialmodelingprep.com/stable";
      const [house, senate] = await Promise.all([
        fetchJson(`${base}/house-latest?page=0&limit=25&apikey=${encodeURIComponent(fmpKey)}`),
        fetchJson(`${base}/senate-latest?page=0&limit=25&apikey=${encodeURIComponent(fmpKey)}`),
      ]);
      return NextResponse.json(finish("fmp", [
        ...mapFmp(Array.isArray(house) ? house : [], "House"),
        ...mapFmp(Array.isArray(senate) ? senate : [], "Senate"),
      ]));
    }
    return NextResponse.json<FeedResponse>({ live: false, source: "none", status: "unconfigured", items: [] });
  } catch (err) {
    console.warn("feed: upstream failed:", String(err));
    return NextResponse.json<FeedResponse>(
      { live: false, source: unusualWhalesKey ? "unusual_whales" : "fmp", status: "upstream_error", items: [] },
      { status: 502 },
    );
  }
}
