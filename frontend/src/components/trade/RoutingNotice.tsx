"use client";

// Uniswap's router only routes v4 pools whose hook is on its allowlist. CoatFeeHook uses a
// delta flag, so until that review lands the Uniswap app cannot see the hooked pool and
// quotes from thin third-party COAT pools instead, showing a huge "price impact". The
// swaps on this site hit the real pool directly.
export function RoutingNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`border-l-[3px] border-accent bg-cream-2 px-4 ${compact ? "py-2.5 text-[12px]" : "py-3 text-sm"}`} role="note">
      <b className="text-ink-strong">Trade $COAT here, not in the Uniswap app.</b>{" "}
      Uniswap&rsquo;s router does not yet route through the hooked pool that holds all the real
      liquidity, so it quotes from tiny third-party pools and shows a huge price impact. Swaps on
      this page go to the real pool directly. OpenSea&rsquo;s swap also reads the real pool.
    </div>
  );
}
