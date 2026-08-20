"use client";

import { useLeaderboard } from "@/lib/useLeaderboard";
import { BrokerArtwork } from "@/components/ui/BrokerArtwork";

function sinceLabel(ms: number | null): string {
  if (ms === null) return "—";
  const days = Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month" : `${months} months`;
}

export function LeadersTab() {
  const { entries, loading, error } = useLeaderboard(25);

  return (
    <div className="max-w-3xl">
      <p className="font-pixel text-[11px] tracking-widest text-ink-soft">THE LEADERBOARD</p>
      <h1 className="font-pixel text-ink-strong text-[22px] sm:text-[26px] leading-snug mt-3">
        OG Brokers.
      </h1>
      <p className="text-lg text-ink-strong leading-relaxed mt-4">
        Every active Broker earns an equal share of every purchase — so the ones that switched on
        earliest and never left have the deepest track record. This ranks them by how long they&rsquo;ve
        been continuously earning.
      </p>
      <p className="text-ink-soft text-sm mt-2">
        Built entirely from the collection&rsquo;s own on-chain activation events — anyone can replay it.
      </p>

      <div className="card mt-6 !p-0 overflow-hidden">
        {loading ? (
          <p className="text-ink-soft text-sm p-5">Reading activation history from the chain…</p>
        ) : error ? (
          <p className="text-ink-soft text-sm p-5">Couldn&rsquo;t load the leaderboard right now — try again shortly.</p>
        ) : entries.length === 0 ? (
          <p className="text-ink-soft text-sm p-5">No active Brokers yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {entries.map((e) => (
              <li key={e.id.toString()} className="flex items-center gap-4 px-4 py-3">
                <span
                  className={`font-pixel text-sm w-8 shrink-0 text-center ${
                    e.rank <= 3 ? "text-accent" : "text-ink-soft"
                  }`}
                >
                  {e.rank}
                </span>
                <div className="border border-line bg-cream shrink-0">
                  <BrokerArtwork tokenId={e.id} size={44} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-pixel text-[12px] text-ink-strong">Broker #{e.id.toString()}</div>
                  <div className="text-[12px] text-ink-soft">earning for {sinceLabel(e.sinceMs)}</div>
                </div>
                <span className="font-pixel text-[9px] px-1.5 py-0.5 border border-good text-good shrink-0">
                  ON
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[11px] text-ink-soft mt-4">
        Rank reflects continuous active time, not guaranteed value. Rewards are trading-volume funded.
      </p>
    </div>
  );
}
