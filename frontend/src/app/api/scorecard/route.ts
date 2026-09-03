import { NextResponse } from "next/server";

// The basket scorecard the indexer publishes every pass: per name, what the engine paid
// (ETH priced at the Chainlink ETH/USD round of each purchase) against today's Chainlink
// price. The raw event list is dropped here; the browser only needs the summary.
export const revalidate = 300;

const DEFAULT_URL = "https://raw.githubusercontent.com/dnebayis/brokers/data/basket-scorecard.json";

export async function GET() {
  const url = process.env.SCORECARD_DATA_URL || DEFAULT_URL;
  try {
    const res = await fetch(url, { next: { revalidate }, headers: { "User-Agent": "coattail-site/1.0" } });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const { events: _events, tokens: _tokens, ...summary } = await res.json();
    void _events; void _tokens;
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.warn("scorecard: upstream failed:", String(err));
    return NextResponse.json({ ok: false, error: "scorecard unavailable" }, { status: 502 });
  }
}
