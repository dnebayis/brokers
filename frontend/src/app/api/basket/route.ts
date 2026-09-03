import { NextResponse } from "next/server";

// The indexer's latest basket report: weights, who bought each name (attribution), what
// was left out and why, and the model-written note. The indexer publishes it to the
// repository's `data` branch every pass; this route proxies it so the browser never talks
// to GitHub and the payload is cached for five minutes at the edge.
export const revalidate = 300;

const DEFAULT_URL = "https://raw.githubusercontent.com/dnebayis/brokers/data/basket-latest.json";

export async function GET() {
  const url = process.env.BASKET_DATA_URL || DEFAULT_URL;
  try {
    const res = await fetch(url, { next: { revalidate }, headers: { "User-Agent": "coattail-site/1.0" } });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const payload = await res.json();
    return NextResponse.json({ ok: true, ...payload });
  } catch (err) {
    console.warn("basket: upstream failed:", String(err));
    return NextResponse.json({ ok: false, error: "basket report unavailable" }, { status: 502 });
  }
}
