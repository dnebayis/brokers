"use client";

import { useLeaderboard } from "@/lib/useLeaderboard";
import { useWalletLeaders } from "@/lib/useWalletLeaders";
import { BrokerArtwork } from "@/components/ui/BrokerArtwork";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

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
  const { leaders, totalActive, holders, loading: wLoading, error: wError } = useWalletLeaders(15);

  return (
    <div className="max-w-3xl">
      <p className="font-pixel text-[11px] tracking-widest text-ink-soft">THE LEADERBOARD</p>
      <h1 className="font-pixel text-ink-strong text-[22px] sm:text-[26px] leading-snug mt-3">
        The biggest desks.
      </h1>
      <p className="text-lg text-ink-strong leading-relaxed mt-4">
        Every active Broker earns an equal share of every purchase. So a wallet&rsquo;s cut of the
        engine is exactly how many active Brokers it holds — not an estimate, the mechanism itself.
        {holders > 0 && (
          <> Right now {holders.toLocaleString("en-US")} wallet{holders === 1 ? "" : "s"} hold the
          collection and {totalActive.toLocaleString("en-US")} Broker{totalActive === 1 ? " is" : "s are"}{" "}
          switched on.</>
        )}
      </p>
      <p className="text-ink-soft text-sm mt-2">
        Built from the collection&rsquo;s own transfer and activation events — anyone can replay it.
      </p>

      <div className="card mt-6 !p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-line">
          <h2 className="pixel-title text-[13px]">Top wallets</h2>
          <p className="text-[12px] text-ink-soft mt-0.5">
            Ranked by Brokers switched on, which is the same as ranked by earnings.
          </p>
        </div>
        {wLoading ? (
          <p className="text-ink-soft text-sm p-5">Replaying transfers from the chain…</p>
        ) : wError ? (
          <p className="text-ink-soft text-sm p-5">Couldn&rsquo;t load wallets right now — try again shortly.</p>
        ) : leaders.length === 0 ? (
          <p className="text-ink-soft text-sm p-5">No holders yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {leaders.map((w) => (
              <li key={w.address} className="flex items-center gap-4 px-4 py-2.5">
                <span
                  className={`font-pixel text-sm w-8 shrink-0 text-center ${
                    w.rank <= 3 ? "text-accent" : "text-ink-soft"
                  }`}
                >
                  {w.rank}
                </span>
                <div className="min-w-0 flex-1">
                  <code className="font-pixel text-[11px] text-ink-strong">{short(w.address)}</code>
                  <div className="text-[12px] text-ink-soft">
                    {w.held} Broker{w.held === 1 ? "" : "s"} held · {w.active} earning
                  </div>
                </div>
                <span className="font-sans text-sm text-good shrink-0">
                  {(w.share * 100).toFixed(1)}%
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-ink-soft px-4 py-3 border-t border-line">
          The percentage is the wallet&rsquo;s share of every purchase the engine makes. A Broker that
          is held but switched off earns nothing and is counted separately.
        </p>
      </div>

      <h2 className="pixel-title text-[13px] mt-9">OG Brokers</h2>
      <p className="text-ink-soft text-sm mt-1">
        Ranked by how long each has been continuously earning, from its own activation events.
      </p>

      <div className="card mt-3 !p-0 overflow-hidden">
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
