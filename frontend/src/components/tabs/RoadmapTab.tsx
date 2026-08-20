"use client";

import { OPENSEA_URL } from "@/lib/config";

// The roadmap mirrors the published roadmap article. Status tags are honest maturity
// markers, not promises — only LIVE/CONTINUOUS items describe what already runs; the
// rest are framed as direction ("the goal is", "exploring") to avoid over-committing.
type Status = "live" | "horizon" | "exploratory" | "hardening" | "continuous";

const STATUS_LABEL: Record<Status, string> = {
  live: "Live now",
  horizon: "On the horizon",
  exploratory: "Exploratory",
  hardening: "Hardening",
  continuous: "Continuous",
};

function StatusTag({ status }: { status: Status }) {
  const accent = status === "horizon" || status === "exploratory";
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
    no: "03",
    status: "exploratory",
    title: "The broker as a primitive",
    body: (
      <>
        Right now a broker quietly accumulates. But an NFT that owns a real wallet with a real,
        on-chain history is more than a collectible — it&rsquo;s a <b>portfolio with a track
        record</b>. The direction we&rsquo;re exploring: brokers that carry a verifiable history,
        reward the ones that stay active, and let that wallet play a role in the wider on-chain
        economy. The object you hold becomes a financial identity, not just a receipt.
      </>
    ),
  },
  {
    no: "04",
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
    no: "05",
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
  return (
    <div className="max-w-3xl">
      {/* Thesis */}
      <p className="font-pixel text-[11px] tracking-widest text-ink-soft">THE ROADMAP</p>
      <h1 className="font-pixel text-ink-strong text-[22px] sm:text-[26px] leading-snug mt-3">
        A brokerage that outlives us.
      </h1>
      <p className="text-lg text-ink-strong leading-relaxed mt-4">
        Coattail already works — 1,776 brokers, sold out; 916 of them switched on and buying real
        tokenized stock on their own, right now. This is where it goes next, and the guarantees that
        never move while it gets there.
      </p>
      <p className="text-ink leading-relaxed mt-3">
        A roadmap here doesn&rsquo;t mean rewriting what exists. The contracts are frozen by design.
        What grows is everything <i>around</i> them: how much the basket can reach, what signals it
        can follow, how independently it runs, and how completely you can verify it. Five horizons,
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
        A wider basket. More strategies than one. A broker that becomes an identity. A machine that
        runs without us. And nothing, anywhere, you have to take on faith.
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
