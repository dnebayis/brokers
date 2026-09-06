"use client";

// CoatFeeHook is on Uniswap's hook routing allowlist since early September: the Uniswap app
// now routes ETH/COAT through the hooked pool that holds the real liquidity, and its quotes
// match this page within the pool's fees. Before that review landed it quoted from thin
// third-party pools with a huge "price impact"; this note used to warn about it.
export function RoutingNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`border-l-[3px] border-line bg-cream-2 px-4 ${compact ? "py-2.5 text-[12px]" : "py-3 text-sm"}`} role="note">
      <b className="text-ink-strong">Same pool everywhere.</b>{" "}
      Swaps on this page, in the Uniswap app and in OpenSea&rsquo;s swap all go through the one
      hooked pool that holds the real $COAT liquidity, so quotes should agree. If a quote looks far
      off, it is a different pool: check the pool address.
    </div>
  );
}
