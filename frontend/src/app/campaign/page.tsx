"use client";

// The sponsored desk: one community's holders, each given a seat that is a Broker in the
// campaign wallet. Everything shown is read live from the open Broker API (roster, which
// seats are switched on) or derived from it (what those switch-ons burned, where the
// calendar stands). The rules, eligibility and rewards are the partner's and live on their
// page; this page never restates them. `?preview=1` renders the layout with placeholder
// data when the campaign is switched off.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Header } from "@/components/Header";
import { CAMPAIGN } from "@/lib/campaign";
import { PARAMS } from "@/lib/config";
import { explorerAddress } from "@/lib/chains";

type RosterRow = { id: number; active: boolean; wallet: string };

const PREVIEW_ROSTER: RosterRow[] = Array.from({ length: 100 }, (_, i) => ({
  id: 101 + i * 7,
  active: i % 5 !== 4,
  wallet: "0x0000000000000000000000000000000000000000",
}));

const num = (n: number) => n.toLocaleString("en-US");
const compact = (n: number) => n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="font-pixel text-[11px] text-ink-soft uppercase tracking-wider">{label}</div>
      <div className="font-pixel text-2xl text-ink-strong mt-1.5 break-words">{value}</div>
      {hint && <div className="text-xs text-ink-soft mt-1">{hint}</div>}
    </div>
  );
}

function CampaignInner() {
  // Design-review flag read on mount, not via useSearchParams: the page has no other
  // URL state, and skipping the router hook keeps it free of a Suspense boundary.
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    if (!CAMPAIGN.live && new URLSearchParams(window.location.search).get("preview") === "1") setPreview(true);
  }, []);
  const showLive = CAMPAIGN.live || preview;

  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { if (preview) setRoster(PREVIEW_ROSTER); }, [preview]);

  useEffect(() => {
    if (!CAMPAIGN.live || !CAMPAIGN.wallet) return;
    let alive = true;
    const load = () =>
      fetch(`/api/wallet/${CAMPAIGN.wallet}/brokers`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => { if (alive) { setRoster(d.brokers ?? []); setError(false); } })
        .catch(() => { if (alive) setError(true); });
    void load();
    // Seats switch on in bursts while activations are open; keep the count honest.
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const active = useMemo(() => roster?.filter((b) => b.active).length ?? 0, [roster]);
  const burned = active * PARAMS.activationBurn;

  // Calendar, read once per mount: which week the desk is in and how many days remain.
  const [calendar, setCalendar] = useState<{ week: number; daysLeft: number; started: boolean } | null>(null);
  useEffect(() => {
    if (!CAMPAIGN.startDate) { if (preview) setCalendar({ week: 1, daysLeft: 27, started: true }); return; }
    const start = Date.parse(`${CAMPAIGN.startDate}T00:00:00Z`);
    const end = start + CAMPAIGN.weeks * 7 * 86_400_000;
    const now = Date.now();
    const days = (now - start) / 86_400_000;
    setCalendar({
      started: now >= start,
      week: Math.min(CAMPAIGN.weeks, Math.max(0, Math.floor(days / 7) + 1)),
      daysLeft: Math.max(0, Math.ceil((end - now) / 86_400_000)),
    });
  }, [preview]);

  if (!showLive) {
    return (
      <div className="card mt-6 p-5">
        <p className="text-ink leading-relaxed">
          A sponsored campaign is in preparation. The roster, which seats are switched on and
          what that burned will appear here, all read live from the chain, once it starts.
        </p>
        <p className="text-ink-soft text-sm mt-3">
          Until then: every Broker is queryable today via the open API documented on the Docs tab.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      {preview && <p className="chip inline-block">PREVIEW — PLACEHOLDER DATA</p>}

      <p className="text-ink leading-relaxed">
        {CAMPAIGN.seats > 0 ? `${num(CAMPAIGN.seats)} ` : ""}{CAMPAIGN.partnerName} holders each get a seat at the desk.
        A seat is a Coattail Broker held in the campaign wallet and switched on the only way a Broker
        can be: by burning {num(PARAMS.activationBurn)} $COAT. From there it earns like every other
        active Broker, real tokenized stock into its own wallet on Robinhood Chain, bought with trading
        fees from what members of Congress disclose.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Seats" value={CAMPAIGN.seats > 0 ? num(CAMPAIGN.seats) : (roster ? num(roster.length) : "…")}
          hint={roster ? `${num(roster.length)} Brokers in the campaign wallet` : undefined} />
        <Stat label="Switched on" value={roster ? num(active) : "…"} hint="read from the chain, refreshed every minute" />
        <Stat label="$COAT burned" value={roster ? compact(burned) : "…"} hint={`${num(PARAMS.activationBurn)} per activation`} />
        <Stat label="Week" value={calendar ? `${calendar.week} / ${CAMPAIGN.weeks}` : "…"}
          hint={calendar ? (calendar.started ? `${num(calendar.daysLeft)} days left` : "not started yet") : undefined} />
      </div>

      <div className="card p-4">
        <h2 className="font-pixel text-sm text-ink-strong">Got a seat?</h2>
        <p className="text-ink text-sm mt-2 leading-relaxed">
          Your seat number is a Broker id. Open it on the start page to see what stock is in it, what the
          engine still owes it and whether it is switched on: no wallet, no sign-in, nothing to approve.
          On Robinhood Chain there is never anything for you to sign for this campaign.
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          <Link className="btn text-[11px]" href="/start">Look up my seat</Link>
          {CAMPAIGN.partnerUrl && (
            <a className="btn btn-ghost text-[11px]" href={CAMPAIGN.partnerUrl} target="_blank" rel="noreferrer">
              Join, rules and rewards on the {CAMPAIGN.partnerName} side ↗
            </a>
          )}
        </div>
      </div>

      <div className="card p-4">
        <h2 className="font-pixel text-sm text-ink-strong">The desk roster</h2>
        <p className="text-ink-soft text-sm mt-1">
          Every Broker in the campaign wallet. Ink means switched on. Tap one to open its seat.
          {CAMPAIGN.wallet && (
            <> Campaign wallet:{" "}
              <a className="font-pixel text-[11px] break-all underline" href={explorerAddress(CAMPAIGN.wallet)} target="_blank" rel="noreferrer">
                {CAMPAIGN.wallet}
              </a>
            </>
          )}
        </p>
        {error && !roster && <p className="text-accent text-sm mt-3">Could not read the roster just now. Try again in a moment.</p>}
        {roster && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {roster.map((b) => (
              <Link key={b.id} href={`/start?broker=${b.id}`}
                title={b.active ? "switched on" : "not switched on yet"}
                className={`font-pixel text-[10px] px-1.5 py-1 border border-line ${
                  b.active ? "bg-ink text-cream" : "bg-cream-2 text-ink-soft"
                }`}>
                #{b.id}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="card p-4">
        <h2 className="font-pixel text-sm text-ink-strong">Who does what</h2>
        <ul className="list-disc ml-5 space-y-1.5 text-ink text-sm mt-2">
          <li><b>{CAMPAIGN.partnerName}</b> holds the Brokers, switches them on, assigns the seats, runs eligibility
            and pays the campaign rewards. Those rules are theirs and live on their page.</li>
          <li><b>Coattail</b> runs the engine that fills the seats: the fee flow, the basket, the buying and
            the payouts into every Broker wallet. We never hold anyone&rsquo;s rewards.</li>
          <li><b>The chain</b> settles it. Ownership, activation, holdings and every purchase are public;
            the roster above and the campaign wallet link to the explorer.</li>
        </ul>
        <p className="text-ink-soft text-sm mt-3">
          The full mechanics, contract addresses and the open API are on the{" "}
          <Link className="underline" href="/">Docs tab</Link>. Historical, never a forecast. Check the chain.
        </p>
      </div>
    </div>
  );
}

export default function CampaignPage() {
  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto px-4 py-10">
        <p className="chip inline-block">SPONSORED DESK</p>
        <h1 className="pixel-title text-xl mt-4">
          {CAMPAIGN.live && CAMPAIGN.partnerName ? `${CAMPAIGN.partnerName} x Coattail Brokers` : "The sponsored desk."}
        </h1>
        <CampaignInner />
      </div>
    </>
  );
}
