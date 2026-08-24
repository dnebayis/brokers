"use client";

// Joint sponsored-campaign stats page. Skeleton ships unlinked and unlisted with
// CAMPAIGN.live=false; the launch commit fills src/lib/campaign.ts and flips the flag.
// Everything shown while live is either read from the public Broker API (roster,
// activation states) or appended from distribution receipts — no manual numbers.
// `?preview=1` renders the live layout with placeholder data for design review.

import { useEffect, useMemo, useState } from "react";
import { Header } from "@/components/Header";
import { CAMPAIGN, DISTRIBUTIONS, type Distribution } from "@/lib/campaign";

type RosterRow = { id: number; active: boolean; wallet: string };

const PREVIEW_ROSTER: RosterRow[] = Array.from({ length: 100 }, (_, i) => ({
  id: 101 + i * 7,
  active: i % 5 !== 4,
  wallet: "0x0000000000000000000000000000000000000000",
}));
const PREVIEW_DISTRIBUTIONS: Distribution[] = [
  { week: 1, date: "2026-09-01", recipients: 87, totalLabel: "week one drip", receiptsNote: "receipts published at launch" },
];

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="font-pixel text-[11px] text-ink-soft uppercase tracking-wider">{label}</div>
      <div className="font-pixel text-2xl text-ink-strong mt-1.5">{value}</div>
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
    fetch(`/api/wallet/${CAMPAIGN.wallet}/brokers`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { if (alive) setRoster(d.brokers ?? []); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);

  const distributions = preview ? PREVIEW_DISTRIBUTIONS : DISTRIBUTIONS;
  const active = useMemo(() => roster?.filter((b) => b.active).length ?? 0, [roster]);
  const [weeksElapsed, setWeeksElapsed] = useState(0);
  useEffect(() => {
    if (!CAMPAIGN.startDate) { if (preview) setWeeksElapsed(1); return; }
    const days = (Date.now() - new Date(CAMPAIGN.startDate).getTime()) / 86_400_000;
    setWeeksElapsed(Math.min(CAMPAIGN.weeks, Math.max(0, Math.floor(days / 7) + 1)));
  }, [preview]);

  if (!showLive) {
    return (
      <div className="card mt-6 p-5">
        <p className="text-ink leading-relaxed">
          A sponsored campaign is in preparation. Roster, activation states and weekly
          distribution receipts will appear here, all read live from the chain, once it starts.
        </p>
        <p className="text-ink-soft text-sm mt-3">
          Until then: every Broker is queryable today via the open API documented on the Docs tab.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      {preview && (
        <p className="chip inline-block">PREVIEW — PLACEHOLDER DATA</p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Sponsored Brokers" value={String(roster?.length ?? CAMPAIGN.brokerCount)}
          hint="held in the campaign wallet" />
        <Stat label="Active" value={roster ? String(active) : "…"}
          hint="clocked in and earning" />
        <Stat label="Week" value={`${weeksElapsed} / ${CAMPAIGN.weeks}`} />
        <Stat label="Distributions" value={String(distributions.length)}
          hint="weekly drips executed" />
      </div>

      <div className="card p-4">
        <h2 className="font-pixel text-sm text-ink-strong">The desk roster</h2>
        <p className="text-ink-soft text-sm mt-1">
          Ownership and activation are confirmed on-chain per token via the open Broker API.
          {CAMPAIGN.wallet && (
            <> Campaign wallet: <span className="font-pixel text-[11px] break-all">{CAMPAIGN.wallet}</span></>
          )}
        </p>
        {error && <p className="text-accent text-sm mt-3">Roster fetch failed — retry shortly.</p>}
        {roster && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {roster.map((b) => (
              <span key={b.id}
                title={b.active ? "active" : "not activated"}
                className={`font-pixel text-[10px] px-1.5 py-1 border border-line ${
                  b.active ? "bg-ink text-cream" : "bg-cream-2 text-ink-soft"
                }`}>
                #{b.id}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card p-4">
        <h2 className="font-pixel text-sm text-ink-strong">Weekly distributions</h2>
        {distributions.length === 0 ? (
          <p className="text-ink-soft text-sm mt-2">First drip lands in week one — receipts will be listed here.</p>
        ) : (
          <table className="w-full border-collapse text-sm mt-3">
            <thead>
              <tr>
                {["Week", "Date", "Recipients", "Total", "Receipts"].map((h) => (
                  <th key={h} className="border border-line bg-cream-3 px-2.5 py-2 text-left font-pixel text-[10px] uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {distributions.map((d) => (
                <tr key={d.week}>
                  <td className="border border-line px-2.5 py-2">{d.week}</td>
                  <td className="border border-line px-2.5 py-2">{d.date}</td>
                  <td className="border border-line px-2.5 py-2">{d.recipients}</td>
                  <td className="border border-line px-2.5 py-2">{d.totalLabel}</td>
                  <td className="border border-line px-2.5 py-2 text-ink-soft">{d.receiptsNote ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card p-4">
        <h2 className="font-pixel text-sm text-ink-strong">How it works</h2>
        <ol className="list-decimal ml-5 space-y-1.5 text-ink text-sm mt-2">
          <li>The sponsor holds a fixed set of Brokers in one campaign wallet, all activated by burning $COAT.</li>
          <li>Active Brokers accrue tokenized-stock salary from the Booster like every other active Broker — same pool, same equal share.</li>
          <li>Participation rewards are distributed weekly off-chain by the sponsor; every batch send is receipted and listed above.</li>
          <li>Snapshots for eligibility use the open Broker API; the chain is the source of truth.</li>
        </ol>
      </div>
    </div>
  );
}

export default function CampaignPage() {
  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto px-4 py-10">
        <p className="chip inline-block">SPONSORED CAMPAIGN</p>
        <h1 className="pixel-title text-xl mt-4">
          {CAMPAIGN.live && CAMPAIGN.partnerName ? `${CAMPAIGN.partnerName} x Coattail Brokers` : "The sponsored desk."}
        </h1>
        <CampaignInner />
      </div>
    </>
  );
}
