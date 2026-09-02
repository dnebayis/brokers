"use client";

import { useEffect, useState } from "react";
import { ADDR, OPENSEA_URL } from "@/lib/config";
import { boosterAbi } from "@/lib/abis";
import { publicClient as client } from "@/lib/client";

// The roadmap mirrors the published roadmap article. Status tags are honest maturity
// markers, not promises — only LIVE/CONTINUOUS items describe what already runs; the
// rest are framed as direction ("the goal is", "exploring") to avoid over-committing.
type Status = "live" | "works" | "horizon" | "design" | "exploratory" | "hardening" | "continuous";

const STATUS_LABEL: Record<Status, string> = {
  live: "Live now",
  works: "In the works",
  horizon: "On the horizon",
  design: "In design",
  exploratory: "Exploratory",
  hardening: "Hardening",
  continuous: "Continuous",
};

function StatusTag({ status }: { status: Status }) {
  const accent = status === "horizon" || status === "exploratory" || status === "works" || status === "design";
  const good = status === "live" || status === "continuous";
  const cls = good
    ? "border-good text-good"
    : accent
      ? "border-accent text-accent"
      : "border-ink-soft text-ink-soft";
  return (
    <span className={`font-pixel text-[10px] tracking-wide px-2 py-1 border-[1.5px] ${cls}`}>
      {STATUS_LABEL[status].toUpperCase()}
    </span>
  );
}

const HORIZONS: { no: string; status: Status; title: string; body: React.ReactNode }[] = [
  {
    no: "01",
    status: "live",
    title: "The basket becomes whole",
    body: (
      <>
        Today the broker can only buy what already exists as a tokenized asset on Robinhood Chain —
        roughly half of what Congress nets in a given window. It already reaches past plain equities
        into ETFs, treasuries and commodities. As the chain&rsquo;s tokenized universe fills in, that
        coverage climbs toward the real thing: a broker that mirrors the <b>whole disclosed
        portfolio</b>, not a slice of it. No upgrade on your side — new routes switch on and the next
        buy simply includes them.
      </>
    ),
  },
  {
    no: "02",
    status: "live",
    title: "An earlier signal",
    body: (
      <>
        The STOCK Act gives members up to 45 days to file — but many disclosures surface well
        before that window closes. Delivered: the basket now rebuilds <b>every hour</b> instead
        of every six, so a new filing lands within the hour it surfaces. Next on this horizon is
        cutting that to <b>the moment it appears</b>. To be clear: not
        front-running Congress — just driving our own added lag to zero, so the basket reflects
        each disclosure as early as it can legally be known.
      </>
    ),
  },
  {
    no: "03",
    status: "live",
    title: "The Floor: the terminal opens",
    body: (
      <>
        Delivered. The engine&rsquo;s rails are no longer holders-only: <b>The Floor</b> lets anyone
        buy or exit the live Congress basket in one transaction, paying with $COAT, ETH or USDG —
        Chainlink-guarded, non-custodial, settled in your wallet in the same block. Every trade
        pays a 0.3% fee and all of it streams straight into Broker payroll: strangers trading the
        basket now feed the 1,776.
      </>
    ),
  },
  {
    no: "04",
    status: "horizon",
    title: "Beyond Congress",
    body: (
      <>
        Congress is the first strategy the engine runs — not the only one it can. Underneath, the
        broker doesn&rsquo;t care where the signal comes from, only that it&rsquo;s <b>disclosed and
        verifiable on chain</b>. That opens a strategy layer: other mandatory, public filings become
        new baskets the same machine can follow. The goal is one broker in your wallet with more than
        one way to earn — chosen or blended, never forced.
      </>
    ),
  },
  {
    no: "05",
    status: "design",
    title: "The vault: Congress for everyone",
    body: (
      <>
        A copy-trade vault for the mass market: deposit a dollar-stable token, hold a share of a
        portfolio that mirrors Congress, withdraw at value any time — no NFT, no brokerage account,
        from anywhere the product can legally serve. Management fees buy and burn $COAT, and
        <b> Broker holders share the vault&rsquo;s revenue</b> — the collection becomes the premium
        tier of a much larger machine. It ships security-first: independently audited,
        deposit-capped to measured market depth, withdrawals no admin can pause — or it
        doesn&rsquo;t ship at all.
      </>
    ),
  },
  {
    no: "06",
    status: "works",
    title: "Playbooks: the broker takes orders",
    body: (
      <>
        An NFT that owns a real wallet is more than a collectible — it&rsquo;s a <b>portfolio that
        can follow instructions</b>. In the works now: <b>Playbooks</b>, standing orders the hourly
        engine executes for your Broker — collect the salary automatically, convert it to USDG or
        $COAT, deliver it wherever you choose. One setup, revocable any time, dies with a transfer
        so a buyer never inherits your instructions. No new fee: conversions ride The Floor, whose
        fee already pays salaries.
      </>
    ),
  },
  {
    no: "07",
    status: "hardening",
    title: "A machine no one has to run",
    body: (
      <>
        The buying is already permissionless — anyone can trigger it. In practice, today it&rsquo;s
        our automation doing the work. Recently we made that automation <b>self-healing</b>: it now
        survives dead pools, network faults and running low on fuel on its own. The endpoint is
        credible neutrality — a keeper set distributed enough that the engine keeps buying even if we
        disappear. As trustless as the contracts it drives.
      </>
    ),
  },
  {
    no: "08",
    status: "continuous",
    title: "Nothing you can’t check",
    body: (
      <>
        A live proof panel already shows every burn and every buy as it happens. The work from here
        is to close the gap completely: <b>each broker&rsquo;s real holdings</b> legible in its own
        metadata, full historical accounting, and the last contracts independently verified. The
        finish line is simple — every claim this project makes should be reconstructable from chain
        data by a stranger who trusts none of us.
      </>
    ),
  },
];

const CHARTER: { m: string; text: React.ReactNode }[] = [
  { m: "01", text: <><b>0% to the team.</b> Nothing pre-mined, nothing reserved. A fair launch, on chain to check.</> },
  { m: "02", text: <><b>Fixed 1B supply, only shrinking.</b> Fees buy stock and burn $COAT. Supply never goes up.</> },
  { m: "03", text: <><b>Immutable core.</b> The contracts that hold and move value have no admin backdoor and no upgrade path.</> },
  { m: "04", text: <><b>Liquidity locked forever.</b> The pool can&rsquo;t be pulled — the lock is permanent and on chain.</> },
  { m: "05", text: <><b>Permissionless by default.</b> Buying, claiming and proving don&rsquo;t need us present to work.</> },
];

export function RoadmapTab() {
  // Live active-Broker count — a hardcoded figure here drifted stale within days.
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    client.readContract({ address: ADDR.booster, abi: boosterAbi, functionName: "activeShares" })
      .then((v) => { if (live) setActive(Number(v)); })
      .catch(() => { /* copy falls back to the undated phrasing */ });
    return () => { live = false; };
  }, []);
  return (
    <div className="max-w-3xl">
      {/* Thesis */}
      <p className="font-pixel text-[11px] tracking-widest text-ink-soft">THE ROADMAP</p>
      <h1 className="font-pixel text-ink-strong text-[22px] sm:text-[26px] leading-snug mt-3">
        A brokerage that outlives us.
      </h1>
      <p className="text-lg text-ink-strong leading-relaxed mt-4">
        Coattail already works — 1,776 brokers, sold out; {active !== null ? active.toLocaleString("en-US") : "hundreds"} of
        them switched on and buying real tokenized stock on their own, right now. This is where it goes next, and the guarantees that
        never move while it gets there.
      </p>
      <p className="text-ink leading-relaxed mt-3">
        A roadmap here doesn&rsquo;t mean rewriting what exists. The contracts are frozen by design.
        What grows is everything <i>around</i> them: how much the basket can reach, what signals it
        can follow, how independently it runs, and how completely you can verify it. Eight horizons,
        in the order they arrive.
      </p>

      {/* Horizons */}
      <div className="mt-9">
        {HORIZONS.map((h) => (
          <div key={h.no} className="border-t-2 border-line pt-6 mt-6 first:border-t-0 first:pt-0 first:mt-0 grid grid-cols-[auto_1fr] gap-x-5 gap-y-3">
            <div className="font-pixel text-2xl text-line leading-none select-none">{h.no}</div>
            <div>
              <StatusTag status={h.status} />
              <h3 className="font-pixel text-[15px] text-ink-strong mt-3 mb-2 leading-snug">{h.title}</h3>
              <p className="text-ink leading-relaxed">{h.body}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Charter */}
      <div className="card mt-10">
        <p className="font-pixel text-[11px] tracking-widest text-accent">THE PART THAT NEVER MOVES</p>
        <h2 className="font-pixel text-base text-ink-strong mt-2.5 leading-snug">
          The roadmap is additive. The guarantees are frozen.
        </h2>
        <p className="text-ink leading-relaxed mt-3">
          Everything above is something we <i>add</i>. None of it touches the promises that were set
          in the contracts on day one and can&rsquo;t be changed by anyone — including us.
        </p>
        <ul className="mt-5 grid gap-3">
          {CHARTER.map((c) => (
            <li key={c.m} className="grid grid-cols-[auto_1fr] gap-3 items-baseline">
              <span className="font-pixel text-[11px] text-accent">{c.m}</span>
              <span className="text-ink leading-relaxed">{c.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Close */}
      <p className="text-ink-strong text-lg leading-relaxed mt-10">
        A wider basket on an earlier signal. A public floor where anyone can trade it — live now.
        More strategies than one, a vault that opens them to everyone, and a broker that takes your
        orders. A machine that runs without us. And nothing, anywhere, you have to take on faith.
      </p>
      <p className="text-ink leading-relaxed mt-3">
        That&rsquo;s the whole plan. It&rsquo;s already sold out, already burning, already buying. The
        rest is execution — in the open, one verifiable step at a time.
      </p>
      <div className="flex flex-wrap gap-3 mt-6">
        <a className="btn btn-accent" href={OPENSEA_URL} target="_blank" rel="noopener noreferrer">
          Get a Broker &#8599;
        </a>
      </div>
      <p className="text-[11px] text-ink-soft mt-6">
        Not financial or legal advice · participation involves risk.
      </p>
    </div>
  );
}
