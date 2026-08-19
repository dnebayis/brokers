"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { ADDR, BROKER_DEPLOYMENT_BLOCK } from "@/lib/config";
import { EXPLORER_BASE, explorerTx, explorerAddress } from "@/lib/chains";
import { boosterAbi, buybackBurnerAbi, erc20Abi } from "@/lib/abis";
import { client } from "@/lib/client";

// Static, always-true facts anyone can verify on the explorer. These are structural properties
// of the deployed contracts (immutable), not live numbers — so they never go stale.
const FACTS: { k: string; v: string; sub: string; href: string }[] = [
  {
    k: "Liquidity locked",
    v: "Permanent",
    sub: "The v4 LP position sits in an ownerless locker with no withdrawal path.",
    href: explorerAddress(ADDR.lpLocker),
  },
  {
    k: "Fair launch",
    v: "0% team",
    sub: "$COAT is a fixed 1B supply. No team, reserve or pre-mine allocation.",
    href: explorerAddress(ADDR.coat),
  },
  {
    k: "Fee split",
    v: "80 / 10 / 10",
    sub: "Every $COAT trade fee is split on-chain: stock buys, treasury, buyback.",
    href: explorerAddress(ADDR.feeSplitter),
  },
  {
    k: "Buyback & burn",
    v: "On-chain",
    sub: "10% of fees buy $COAT and burn it. Supply only ever shrinks.",
    href: explorerAddress(ADDR.buybackBurner),
  },
];

type Row = {
  kind: "burn" | "buy";
  block: bigint;
  logIndex: number;
  tx: string;
  primary: string; // headline amount, e.g. "1,776 $COAT" or "0.02 NVDA"
  eth: number; // ETH spent
  ts?: number;
};

function ago(ts?: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function num(n: number, max = 4): string {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

export function ProofPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Both event streams are sparse (hourly keeper pokes; rare in-band buybacks), so a single
        // full-range query per event is cheap and returns the complete history.
        const [burns, buys] = await Promise.all([
          client.getContractEvents({
            address: ADDR.buybackBurner,
            abi: buybackBurnerAbi,
            eventName: "BuybackExecuted",
            fromBlock: BROKER_DEPLOYMENT_BLOCK,
            toBlock: "latest",
          }),
          client.getContractEvents({
            address: ADDR.booster,
            abi: boosterAbi,
            eventName: "Bought",
            fromBlock: BROKER_DEPLOYMENT_BLOCK,
            toBlock: "latest",
          }),
        ]);

        // Resolve symbol + decimals once per distinct stock token (multicall-batched).
        const tokens = Array.from(
          new Set(buys.map((b) => (b.args.token as string).toLowerCase())),
        ) as `0x${string}`[];
        const meta = new Map<string, { symbol: string; decimals: number }>();
        await Promise.all(
          tokens.map(async (t) => {
            try {
              const [symbol, decimals] = await Promise.all([
                client.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }),
                client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }),
              ]);
              meta.set(t, { symbol: symbol as string, decimals: Number(decimals) });
            } catch {
              meta.set(t, { symbol: "stock", decimals: 18 });
            }
          }),
        );

        const all: Row[] = [];
        for (const e of burns) {
          const coat = Number(formatUnits(e.args.coatBurned as bigint, 18));
          all.push({
            kind: "burn",
            block: e.blockNumber,
            logIndex: e.logIndex ?? 0,
            tx: e.transactionHash,
            primary: `${num(coat, 0)} $COAT burned`,
            eth: Number(formatUnits(e.args.ethIn as bigint, 18)),
          });
        }
        for (const e of buys) {
          const t = (e.args.token as string).toLowerCase();
          const m = meta.get(t) ?? { symbol: "stock", decimals: 18 };
          const out = Number(formatUnits(e.args.tokenOut as bigint, m.decimals));
          all.push({
            kind: "buy",
            block: e.blockNumber,
            logIndex: e.logIndex ?? 0,
            tx: e.transactionHash,
            primary: `${num(out)} ${m.symbol}`,
            eth: Number(formatUnits(e.args.ethIn as bigint, 18)),
          });
        }

        all.sort((a, b) =>
          a.block === b.block ? b.logIndex - a.logIndex : Number(b.block - a.block),
        );
        const top = all.slice(0, 12);

        // Best-effort timestamps for just the displayed rows (dedup by block).
        const uniqueBlocks = Array.from(new Set(top.map((r) => r.block)));
        const tsByBlock = new Map<bigint, number>();
        await Promise.all(
          uniqueBlocks.map(async (bn) => {
            try {
              const blk = await client.getBlock({ blockNumber: bn });
              tsByBlock.set(bn, Number(blk.timestamp));
            } catch {
              /* leave time blank */
            }
          }),
        );
        for (const r of top) r.ts = tsByBlock.get(r.block);

        if (!cancelled) {
          setRows(top);
          setFailed(false);
        }
      } catch {
        if (!cancelled) {
          setRows([]);
          setFailed(true);
        }
      }
    }

    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h2 className="pixel-title text-[15px]">Proof &amp; transparency</h2>
        <a
          href={EXPLORER_BASE}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-ghost text-[12px] px-3 py-1.5"
        >
          Explorer ↗
        </a>
      </div>
      <p className="text-ink-soft text-sm mb-5">
        Don&rsquo;t trust — verify. Every claim below points to the chain.
      </p>

      {/* Immutable, always-true facts */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        {FACTS.map((f) => (
          <a
            key={f.k}
            href={f.href}
            target="_blank"
            rel="noopener noreferrer"
            className="stat block hover:border-ink transition-colors"
          >
            <div className="flex items-center justify-between">
              <div className="text-[11px] text-ink-soft uppercase tracking-widest">{f.k}</div>
              <div className="font-pixel text-[12px] text-ink-strong">{f.v} ↗</div>
            </div>
            <div className="text-ink-soft text-[12px] mt-1.5 leading-snug">{f.sub}</div>
          </a>
        ))}
      </div>

      {/* Live on-chain activity */}
      <h3 className="font-pixel text-[12px] text-ink-strong mb-3">Recent on-chain activity</h3>
      {rows === null ? (
        <p className="text-ink-soft text-[12px]">Loading the chain…</p>
      ) : rows.length === 0 ? (
        <p className="text-ink-soft text-[12px]">
          {failed
            ? "Couldn’t reach the chain right now — open the explorer above to verify directly."
            : "No buyback or stock-buy transactions yet. They appear here as the flywheel runs."}
        </p>
      ) : (
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li
              key={`${r.tx}-${r.logIndex}`}
              className="flex items-center gap-3 border-2 border-ink bg-cream px-3 py-2"
            >
              <span
                className={`font-pixel text-[9px] px-2 py-1 border-2 shrink-0 ${
                  r.kind === "burn"
                    ? "bg-accent border-accent text-white"
                    : "bg-cream-3 border-ink text-ink-strong"
                }`}
              >
                {r.kind === "burn" ? "BURN" : "BUY"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-pixel text-[12px] text-ink-strong truncate">{r.primary}</div>
                <div className="text-ink-soft text-[11px]">
                  {r.kind === "burn" ? "buyback " : "Congress-basket buy · "}
                  {num(r.eth, 4)} ETH{r.ts ? ` · ${ago(r.ts)}` : ""}
                </div>
              </div>
              <a
                href={explorerTx(r.tx)}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-ghost text-[11px] px-2.5 py-1 shrink-0"
              >
                tx ↗
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
