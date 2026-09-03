"use client";

import { useStoredQuery } from "@/lib/useStoredQuery";
import { BasketNow } from "@/components/BasketNow";

type FeedItem = {
  chamber: "House" | "Senate";
  member: string;
  symbol: string;
  type: "buy" | "sell" | "other";
  amount: string;
  transactionDate: string;
  disclosureDate: string;
};

type FeedResult = {
  live: boolean;
  source: "unusual_whales" | "fmp" | "none";
  status: "ok" | "unconfigured" | "upstream_error" | "empty";
  items: FeedItem[];
};

async function fetchFeed(): Promise<FeedResult> {
  const res = await fetch("/api/feed");
  const payload = (await res.json()) as FeedResult;
  if (!res.ok) return payload;
  return payload;
}

export function FeedTab() {
  // Persisted across reloads: a hard refresh renders the last feed straight from localStorage
  // with no request, and only revalidates (and updates if it changed) once the hour is up —
  // matching the server cache, so the Unusual Whales quota isn't spent on every page load.
  const { data, isLoading, isError } = useStoredQuery<FeedResult>({
    storageKey: "coattail.feed.v1",
    queryKey: ["congress-feed"],
    queryFn: fetchFeed,
    staleTime: 60 * 60_000,
    // Only a healthy feed earns the hour in storage — failures retry on next visit.
    persistIf: (d) => d.status === "ok",
  });

  return (
    <div className="grid gap-5">
    <BasketNow />
    <div className="card">
      <div className="flex items-center justify-between mb-1">
        <h2 className="pixel-title text-[15px]">Congress disclosures</h2>
        {data && (
          <span className={`badge ${data.live ? "border-good text-good" : "border-ink-soft text-ink-soft"}`}>
            {data.live ? "LIVE" : "OFFLINE"}
          </span>
        )}
      </div>
      <p className="text-ink-soft text-sm mb-4">
        The latest US Congress stock trades (STOCK Act disclosures) — the raw feed the Politician
        basket is built from. Disclosures lag up to ~45 days; this is what was <i>filed</i>.
      </p>

      {isLoading && <p className="text-ink-soft text-sm">Loading disclosures…</p>}
      {isError && <p className="text-accent text-sm">Feed unavailable right now.</p>}

      {data && !data.live && (
        <p className="text-accent text-sm mb-3">
          {data.status === "unconfigured"
            ? "Congress data source is not configured."
            : data.status === "upstream_error"
              ? "The configured Congress data provider rejected or failed the request."
              : "The provider returned no disclosures."}
        </p>
      )}

      {data && data.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[560px]">
            <thead>
              <tr className="text-left">
                {["Member", "Ticker", "Action", "Amount", "Traded", "Filed"].map((h) => (
                  <th key={h} className="border-b-2 border-ink py-2 pr-3 font-pixel text-[10px] uppercase text-ink-soft">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((it, i) => (
                <tr key={i} className="border-b border-line">
                  <td className="py-2.5 pr-3">
                    <span className="text-ink-strong">{it.member}</span>
                    <span className="ml-2 text-[10px] text-ink-soft uppercase">{it.chamber}</span>
                  </td>
                  <td className="py-2.5 pr-3"><span className="badge">{it.symbol}</span></td>
                  <td className="py-2.5 pr-3">
                    <span className={it.type === "buy" ? "text-good" : it.type === "sell" ? "text-accent" : "text-ink-soft"}>
                      {it.type === "buy" ? "▲ BUY" : it.type === "sell" ? "▼ SELL" : "—"}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 text-ink-soft tabular-nums">{it.amount || "—"}</td>
                  <td className="py-2.5 pr-3 text-ink-soft tabular-nums">{it.transactionDate || "—"}</td>
                  <td className="py-2.5 text-ink-soft tabular-nums">{it.disclosureDate || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-ink-soft text-xs mt-3">
        Cached in your browser · refreshes hourly and only when the data changes
        {data?.source && data.source !== "none" ? ` · source: ${data.source.replace("_", " ")}` : ""}.
      </p>
    </div>
    </div>
  );
}
