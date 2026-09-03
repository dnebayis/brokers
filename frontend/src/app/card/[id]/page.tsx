"use client";

// Public earnings card for one Broker, no wallet needed: /card/<id>. The same card the owner
// draws from My Brokers, readable by anyone (a holder can link it from a post, a buyer can
// check a listing). Every figure is read from the chain on load.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { formatUnits, type Address } from "viem";
import { Header } from "@/components/Header";
import { BrokerArtwork } from "@/components/ui/BrokerArtwork";
import { ShareOnX } from "@/components/ShareOnX";
import { ADDR, OPENSEA_URL } from "@/lib/config";
import { brokerAbi, coatAbi, erc20Abi } from "@/lib/abis";
import { publicClient as client } from "@/lib/client";
import { brokerBacking, earnedSinceActivation, loadKnownTokens, usd } from "@/lib/brokerValue";
import { useCoatPrice, usdLabel } from "@/lib/useCoatPrice";
import type { CardData } from "@/lib/shareCard";

type State = { status: "loading" } | { status: "missing" } | { status: "ready"; data: CardData; owner: string };

export default function CardPage() {
  const params = useParams<{ id: string }>();
  const raw = String(params?.id ?? "");
  const valid = /^\d{1,4}$/.test(raw) && Number(raw) >= 1;
  const [state, setState] = useState<State>({ status: "loading" });
  const price = useCoatPrice();

  useEffect(() => {
    let stale = false;
    if (!valid) {
      setState({ status: "missing" });
      return;
    }
    (async () => {
      try {
        const id = BigInt(raw);
        const [owner, active, wallet] = await Promise.all([
          client.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "ownerOf", args: [id] }),
          client.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "activated", args: [id] }),
          client.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "accountOf", args: [id] }),
        ]);
        const metas = await loadKnownTokens();
        const [backing, earned, coat, balances] = await Promise.all([
          brokerBacking(id, metas),
          earnedSinceActivation([id], metas, owner as Address).catch(() => ({}) as Record<string, number>),
          client.readContract({ address: ADDR.coat, abi: coatAbi, functionName: "balanceOf", args: [wallet as Address] }),
          client.multicall({
            allowFailure: true,
            contracts: metas.flatMap((m) => [
              { address: m.token, abi: erc20Abi, functionName: "balanceOf" as const, args: [wallet as Address] as const },
              { address: m.token, abi: erc20Abi, functionName: "symbol" as const },
            ]),
          }),
        ]);
        const symbols: string[] = [];
        metas.forEach((m, i) => {
          const bal = balances[i * 2]?.result;
          const sym = balances[i * 2 + 1]?.result;
          if (typeof bal === "bigint" && bal > 0n && typeof sym === "string") {
            if (Number(formatUnits(bal, m.decimals)) * m.priceUsd >= 0.005) symbols.push(sym);
          }
        });
        if (stale) return;
        setState({
          status: "ready",
          owner: owner as string,
          data: {
            id: raw,
            active: !!active,
            earnedUsd: earned[raw],
            backingUsd: backing.totalUsd,
            coatInside: coat as bigint,
            symbols,
          },
        });
      } catch {
        if (!stale) setState({ status: "missing" });
      }
    })();
    return () => { stale = true; };
  }, [raw, valid]);

  const data = state.status === "ready"
    ? { ...state.data, coatUsd: price.coatWeiToUsd(state.data.coatInside) }
    : null;

  return (
    <>
      <Header />
      <main className="mx-auto max-w-xl px-6 py-10 grid gap-5">
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h1 className="font-pixel text-lg text-ink-strong">Broker card</h1>
            <Link href="/" className="text-[11px] text-ink-soft hover:text-ink-strong underline">coattail.cash</Link>
          </div>
          {state.status === "loading" && <p className="text-ink-soft text-sm">Reading the chain…</p>}
          {state.status === "missing" && (
            <p className="text-ink-soft text-sm">No Broker with that id. Ids run from 1 to 1,776.</p>
          )}
          {data && (
            <>
              <div className="flex items-center gap-3 mb-3">
                <div className="border border-line bg-cream shrink-0">
                  <BrokerArtwork tokenId={BigInt(data.id)} size={72} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-pixel text-sm text-ink-strong">Broker #{data.id}</span>
                    <span className={`badge ${data.active ? "border-good text-good" : "border-ink-soft text-ink-soft"}`}>
                      {data.active ? "ACTIVE" : "INACTIVE"}
                    </span>
                  </div>
                  <div className="text-[12px] text-ink-soft mt-1">
                    {data.active && data.earnedUsd !== undefined
                      ? <>Earned <b className="text-good">{usd(data.earnedUsd)}</b> since switch-on · holds {usd(data.backingUsd ?? 0)} of stock</>
                      : <>Holds {usd(data.backingUsd ?? 0)} of stock</>}
                    {data.coatInside !== undefined && data.coatInside > 0n && (
                      <> · {Math.floor(Number(data.coatInside) / 1e18).toLocaleString("en-US")} $COAT inside ({usdLabel(data.coatUsd)})</>
                    )}
                  </div>
                </div>
              </div>
              <ShareOnX data={data} />
              <p className="text-[11px] text-ink-soft mt-3">
                Owner {state.status === "ready" ? `${state.owner.slice(0, 6)}…${state.owner.slice(-4)}` : ""} ·{" "}
                <a className="underline hover:text-ink-strong" target="_blank" rel="noopener noreferrer"
                  href={`${OPENSEA_URL.replace(/\/collection\/.*$/, "")}/assets/robinhood/${ADDR.broker}/${data.id}`}>
                  view on OpenSea ↗
                </a>
              </p>
            </>
          )}
        </div>
      </main>
    </>
  );
}
