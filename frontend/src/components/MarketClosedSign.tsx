"use client";

import { useEffect, useState } from "react";

// The shop-door sign, hung on Sundays only (product decision: one predictable
// closed-day ritual rather than mirroring every market holiday). "Sunday" is
// judged on the market's own clock (New York), not the viewer's, so the sign
// goes up and comes down for everyone at the same moment and covers the whole
// US-market Sunday regardless of where the viewer sits.
function isMarketSunday(): boolean {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" })
      .format(new Date()) === "Sun"
  );
}

export function MarketClosedSign() {
  // Start hidden and decide after mount: the server and the client can disagree
  // on the day, and a hydration mismatch is worse than a one-frame delay.
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    setClosed(isMarketSunday());
    const iv = setInterval(() => setClosed(isMarketSunday()), 60_000); // lowers itself at midnight NY
    return () => clearInterval(iv);
  }, []);

  if (!closed) return null;

  return (
    <div className="mb-6 w-full max-w-2xl mx-auto flex flex-col items-center" aria-label="Market closed">
      {/* the string it hangs from */}
      <div className="flex gap-16">
        <div className="w-[3px] h-5 bg-ink" />
        <div className="w-[3px] h-5 bg-ink" />
      </div>
      <div className="w-full border-2 border-ink bg-cream-2 shadow-pixel-sm -rotate-1 px-5 py-4 text-center">
        <div className="font-pixel text-base text-accent tracking-wide">MARKET CLOSED</div>
        <p className="mt-2 text-ink-soft text-sm">
          It is Sunday. The stock market is closed, price feeds are frozen at Friday&rsquo;s
          close, and The Floor will not trade at a price it cannot verify. Buying and
          selling wait here until the market reopens.
        </p>
        <p className="mt-2 text-ink-soft text-sm">
          Nothing stops earning meanwhile: fees keep piling into the Booster, and the first
          fresh price after the opening bell spends all of them at once.
        </p>
      </div>
    </div>
  );
}
