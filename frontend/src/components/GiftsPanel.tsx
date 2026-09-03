"use client";

import { useEffect, useState } from "react";
import { ADDR, OPENSEA_URL } from "@/lib/config";
import { explorerAddress, explorerTx } from "@/lib/chains";
import { giftsReady, GIFTS } from "@/lib/gifts";
import { nextDrawLabel, useGiftFeed } from "@/lib/useGifts";

// Gift drops, the public view: when the next draw is, what is queued, and who won so far.
// Every row is a settled on-chain round, so each one links to its transaction.
export function GiftsPanel() {
  const { data, isLoading } = useGiftFeed();
  // Clock lives in state: reading Date.now() during render is impure, and the countdown
  // should tick on its own while the page stays open.
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  if (!giftsReady) return null;
  const cadence = data ? Math.round(data.interval / 86_400) : 0;
  const label = (nft: string, id: string) => {
    const name = data?.names[nft.toLowerCase()] ?? "NFT";
    return `${name} #${id}`;
  };
  const ago = (at: number) => {
    if (!at || !now) return "";
    const s = Math.max(0, Math.floor(now / 1000 - at));
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86_400)}d ago`;
  };
  return (
    <section className="card">
      <div className="flex items-center justify-between mb-1">
        <h2 className="pixel-title text-[15px]">Gift drops</h2>
        <a className="text-[11px] text-ink-soft hover:text-ink-strong underline" href={explorerAddress(GIFTS.vault)}
          target="_blank" rel="noopener noreferrer">vault ↗</a>
      </div>
      <p className="text-ink-soft text-sm mb-4">
        {cadence > 0 ? `Every ${cadence} day${cadence > 1 ? "s" : ""}, ` : "Regularly, "}
        one NFT from the vault goes to a <b className="text-ink-strong">random active Broker</b>. The
        winner is drawn on chain from a block hash, so nobody picks. It lands in the Broker&rsquo;s own
        wallet, travels with the NFT, and the holder can pull it out from My Brokers whenever they like.
      </p>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="stat">
          <div className="text-[11px] text-ink-soft uppercase tracking-widest">Next draw</div>
          <div className="font-pixel text-[13px] text-ink-strong mt-1">{(isLoading && !data) || !now ? "…" : nextDrawLabel(data, now)}</div>
        </div>
        <div className="stat">
          <div className="text-[11px] text-ink-soft uppercase tracking-widest">In the vault</div>
          <div className="font-pixel text-[13px] text-ink-strong mt-1">{data ? data.queued + (data.openRound ? 1 : 0) : "…"}</div>
        </div>
        <div className="stat">
          <div className="text-[11px] text-ink-soft uppercase tracking-widest">Gifted so far</div>
          <div className="font-pixel text-[13px] text-ink-strong mt-1">{data ? data.gifts.length : "…"}</div>
        </div>
      </div>
      {data && data.gifts.length === 0 && (
        <p className="text-ink-soft text-sm">No gift has been drawn yet. Keep your Broker switched on: only active Brokers are in the draw.</p>
      )}
      {data && data.gifts.length > 0 && (
        <div className="grid gap-1.5">
          {data.gifts.slice(0, 12).map((g) => (
            <div key={`${g.round}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm border-b border-line pb-1.5">
              <span className="font-pixel text-[11px] text-ink-strong">Broker #{g.brokerId}</span>
              <span className="text-ink-soft">received</span>
              <a className="badge hover:border-ink" target="_blank" rel="noopener noreferrer"
                href={g.nft.toLowerCase() === ADDR.broker.toLowerCase()
                  ? `${OPENSEA_URL.replace(/\/collection\/.*$/, "")}/assets/robinhood/${g.nft}/${g.id}`
                  : explorerAddress(g.nft)}>
                {label(g.nft, g.id)}
              </a>
              <span className="text-[11px] text-ink-soft ml-auto tabular-nums">{ago(g.at)}</span>
              <a className="text-[11px] text-ink-soft hover:text-ink-strong underline" href={explorerTx(g.tx)}
                target="_blank" rel="noopener noreferrer">tx</a>
            </div>
          ))}
        </div>
      )}
      <p className="text-ink-soft text-xs mt-3">
        Only Brokers that are switched on can win. Want to put an NFT in the vault? Send it with a
        safe transfer to the vault address above and it joins the queue.
      </p>
    </section>
  );
}
