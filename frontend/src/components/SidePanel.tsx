"use client";

import { useAccount, useBalance, useReadContract, useReadContracts } from "wagmi";
import { parseEther } from "viem";
import { ADDR, PARAMS } from "@/lib/config";
import { brokerAbi, boosterAbi, coatAbi, routerAbi } from "@/lib/abis";
import { activeChain } from "@/lib/chains";
import { fmt } from "@/lib/format";
import { useOwnedBrokers } from "@/lib/useOwnedBrokers";

export function SidePanel() {
  const { address } = useAccount();
  const routerReady = ADDR.router !== "";

  const { data } = useReadContracts({
    contracts: [
      { address: ADDR.broker, abi: brokerAbi, functionName: "totalMinted" },
      { address: ADDR.broker, abi: brokerAbi, functionName: "MAX_SUPPLY" },
      { address: ADDR.booster, abi: boosterAbi, functionName: "activeShares" },
    ],
    query: { refetchInterval: 15_000 },
  });
  const minted = (data?.[0]?.result as bigint) ?? 0n;
  const max = (data?.[1]?.result as bigint) ?? BigInt(PARAMS.maxSupply);
  const active = (data?.[2]?.result as bigint) ?? 0n;
  const pct = max > 0n ? Number((minted * 1000n) / max) / 10 : 0;

  const { data: coatPerEth } = useReadContract({
    address: routerReady ? (ADDR.router as `0x${string}`) : undefined,
    abi: routerAbi,
    functionName: "quoteBuy",
    args: [parseEther("1")],
    query: { enabled: routerReady, refetchInterval: 20_000 },
  });

  const { data: eth } = useBalance({ address, chainId: activeChain.id, query: { enabled: !!address } });
  const { data: coat } = useReadContract({
    address: ADDR.coat, abi: coatAbi, functionName: "balanceOf",
    args: address ? [address] : undefined, query: { enabled: !!address },
  });
  const { brokers } = useOwnedBrokers();

  return (
    <aside className="lg:sticky lg:top-24 grid gap-4 content-start">
      <div className="card !p-4">
        <div className="font-pixel text-[11px] text-ink-strong mb-3">Protocol</div>
        <Row k="Minted" v={`${minted} / ${max}`} />
        <div className="h-2 bg-cream-3 border border-ink my-2"><span className="block h-full bg-ink" style={{ width: `${pct}%` }} /></div>
        <Row k="Active Brokers" v={active.toString()} />
        <Row k="Fee split" v="80 / 10 / 10" />
        {routerReady && coatPerEth !== undefined && (
          <Row k="$COAT / ETH" v={fmt(coatPerEth as bigint, 18, 0)} />
        )}
      </div>

      <div className="card !p-4">
        <div className="font-pixel text-[11px] text-ink-strong mb-3">Your wallet</div>
        {!address ? (
          <p className="text-ink-soft text-sm">Connect to see your balances.</p>
        ) : (
          <>
            <Row k="ETH" v={eth ? fmt(eth.value, 18, 4) : "—"} />
            <Row k="$COAT" v={fmt(coat as bigint | undefined, 18, 0)} />
            <Row k="Your Brokers" v={brokers.length.toString()} />
          </>
        )}
      </div>

      <div className="card !p-4">
        <div className="font-pixel text-[11px] text-ink-strong mb-2">How it works</div>
        <ol className="text-[13px] text-ink-soft leading-relaxed list-decimal ml-4 space-y-1">
          <li>Get a Broker on the secondary market</li>
          <li>Burn 36,750 $COAT per Broker to activate</li>
          <li>Claim earned stocks into its wallet</li>
        </ol>
      </div>
    </aside>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between py-1">
      <span className="text-[12px] text-ink-soft uppercase tracking-wide">{k}</span>
      <span className="font-pixel text-sm text-ink-strong tabular-nums">{v}</span>
    </div>
  );
}
