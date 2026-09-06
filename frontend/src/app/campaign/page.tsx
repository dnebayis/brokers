"use client";

// The sponsored desk: one community's holders, each given a seat that is a Broker in the
// campaign wallet. Everything shown is read live from the open Broker API (roster, which
// seats are switched on, what each seat holds) or derived from it. The rules, eligibility
// and rewards are the partner's and live on their page; this page never restates them.
// `?preview=1` renders the layout with placeholder data when the campaign is switched off.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Header } from "@/components/Header";
import { BrokerArtwork } from "@/components/ui/BrokerArtwork";
import { BrokerMark } from "@/components/ui/BrokerMark";
import { Icon } from "@/components/ui/Icon";
import { CAMPAIGN } from "@/lib/campaign";
import { PARAMS } from "@/lib/config";
import { explorerAddress } from "@/lib/chains";
import type { BrokerSnapshot } from "@/lib/brokerApi";

type RosterRow = { id: number; active: boolean; wallet: string };
type Filter = "all" | "on" | "off";

// The partner's brand colour, used only where the page speaks about their side.
const PARTNER_ACCENT = "#ff8a1f";
const PARTNER_LOGO = "/partners/geez.png";

const PREVIEW_ROSTER: RosterRow[] = Array.from({ length: 100 }, (_, i) => ({
  id: 101 + i * 7,
  active: i % 5 !== 4,
  wallet: "0x0000000000000000000000000000000000000000",
}));

const num = (n: number) => n.toLocaleString("en-US");
const compact = (n: number) => n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });

/** Mount children only once the element is near the viewport (142 on-chain artworks otherwise load at once). */
function useNearViewport<T extends HTMLElement>(margin = "320px"): [(el: T | null) => void, boolean] {
  const [seen, setSeen] = useState(false);
  const [obs] = useState(() => (typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) setSeen(true);
  }, { rootMargin: margin })));
  const ref = useCallback((el: T | null) => {
    if (!obs) { setSeen(true); return; }
    obs.disconnect();
    if (el) obs.observe(el);
  }, [obs]);
  return [ref, seen];
}

function PartnerLogo({ className = "h-9" }: { className?: string }) {
  // The file is probed before it is shown, so a missing logo never flashes a broken image:
  // until it loads (or when it is absent) the partner's name stands in, in their colour.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const im = new Image();
    im.onload = () => setReady(true);
    im.src = PARTNER_LOGO;
  }, []);
  if (!ready) {
    return (
      <span className="font-pixel text-xl leading-none" style={{ color: PARTNER_ACCENT }}>
        {CAMPAIGN.partnerName.toUpperCase()}
      </span>
    );
  }
  // A partner logo is a static file we ship ourselves; Next's optimizer adds nothing here.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={PARTNER_LOGO} alt={CAMPAIGN.partnerName} className={`${className} w-auto`} />;
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className="card p-4">
      <div className="font-pixel text-[11px] text-ink-soft uppercase tracking-wider">{label}</div>
      <div className="font-pixel text-2xl mt-1.5 break-words" style={accent ? { color: PARTNER_ACCENT } : undefined}>
        <span className={accent ? "" : "text-ink-strong"}>{value}</span>
      </div>
      {hint && <div className="text-xs text-ink-soft mt-1">{hint}</div>}
    </div>
  );
}

/* ───────────── onboarding ───────────── */

function Onboarding({ onLookup }: { onLookup: (id: number) => void }) {
  const [step, setStep] = useState(0);
  const [seat, setSeat] = useState("");
  const steps = [
    {
      title: "Activate on the " + CAMPAIGN.partnerName + " side",
      body: <>Joining happens on their site, on their chain, by their rules: a staked {CAMPAIGN.partnerName} and their activation fee. The Treasury then switches on a Coattail Broker for you on Robinhood Chain by burning {num(PARAMS.activationBurn)} $COAT. There is nothing for you to sign here, ever.</>,
      action: CAMPAIGN.partnerUrl ? (
        <a className="btn text-[11px]" href={CAMPAIGN.partnerUrl} target="_blank" rel="noreferrer"
          style={{ background: PARTNER_ACCENT, borderColor: PARTNER_ACCENT }}>
          Open the {CAMPAIGN.partnerName} campaign ↗
        </a>
      ) : null,
    },
    {
      title: "Find your seat",
      body: <>Your seat is a Broker number. Type it in, or tap any desk below. Everything about it is read live from the chain: what stock it holds, what the engine still owes it, whether it is switched on.</>,
      action: (
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); const n = Number(seat); if (n > 0) onLookup(n); }}>
          <input className="fld flex-1 min-w-[9rem]" inputMode="numeric" placeholder="Broker number" value={seat}
            onChange={(e) => setSeat(e.target.value.replace(/[^0-9]/g, ""))} aria-label="Broker number" />
          <button className="btn text-[11px]" type="submit"><Icon name="search" /> Open my seat</button>
        </form>
      ),
    },
    {
      title: "Watch it earn",
      body: <>Every $COAT trade pays a fee. The engine turns fees into whatever members of Congress are disclosing as buys, about once an hour, split equally across every switched-on Broker, yours included. The stock lands in the seat&rsquo;s own wallet and stays there; nothing needs claiming from you.</>,
      action: (
        <div className="flex flex-wrap gap-2">
          <Link className="btn btn-ghost text-[11px]" href="/#stats">See the desk&rsquo;s numbers over time</Link>
          <Link className="btn btn-ghost text-[11px]" href="/#feed">What Congress filed this month</Link>
        </div>
      ),
    },
    {
      title: "Claim on the " + CAMPAIGN.partnerName + " side",
      body: <>When the campaign ends and the final check is done, claims open on their site: their rewards plus what your seat earned. Keep your {CAMPAIGN.partnerName} staked and unlisted for the whole run; their page has the exact rules. The Broker itself stays with their Treasury.</>,
      action: CAMPAIGN.partnerUrl ? (
        <a className="btn btn-ghost text-[11px]" href={CAMPAIGN.partnerUrl} target="_blank" rel="noreferrer">Rules and rewards ↗</a>
      ) : null,
    },
  ];
  const s = steps[step];
  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="font-pixel text-sm text-ink-strong">How to take your seat</h2>
        <span className="text-[11px] text-ink-soft">four steps, two on their side</span>
      </div>
      <ol className="mt-3 grid grid-cols-4 gap-1.5" role="tablist" aria-label="Onboarding steps">
        {steps.map((st, i) => {
          const on = i === step, done = i < step;
          return (
            <li key={st.title}>
              <button type="button" role="tab" aria-selected={on} onClick={() => setStep(i)}
                className={`w-full text-left border-2 px-2 py-2 transition-colors ${on ? "border-ink bg-ink text-cream" : done ? "border-ink bg-cream-3 text-ink-strong" : "border-line bg-cream-2 text-ink-soft"}`}>
                <span className="font-pixel text-[10px] block">{done ? "✓ " : ""}{i + 1}</span>
                <span className="text-[11px] leading-tight block mt-0.5 line-clamp-2">{st.title}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="mt-4 border-l-[3px] pl-4" style={{ borderColor: step === 0 || step === 3 ? PARTNER_ACCENT : "var(--c-ink)" }}>
        <h3 className="font-pixel text-[12px] text-ink-strong">{s.title}</h3>
        <p className="text-ink text-sm leading-relaxed mt-2 max-w-2xl">{s.body}</p>
        {s.action && <div className="mt-3">{s.action}</div>}
      </div>
      <div className="flex justify-between mt-4">
        <button type="button" className="btn btn-ghost text-[11px]" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        <button type="button" className="btn text-[11px]" disabled={step === steps.length - 1} onClick={() => setStep(step + 1)}>Next <Icon name="arrow-right" /></button>
      </div>
    </div>
  );
}

/* ───────────── the desks ───────────── */

function Desk({ row, selected, onSelect }: { row: RosterRow; selected: boolean; onSelect: (id: number) => void }) {
  const [ref, near] = useNearViewport<HTMLButtonElement>();
  return (
    <button ref={ref} type="button" onClick={() => onSelect(row.id)} aria-pressed={selected}
      title={row.active ? `Broker #${row.id}, switched on` : `Broker #${row.id}, not switched on yet`}
      className={`group relative border-2 bg-cream-2 p-1.5 text-left transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:shadow-pixel-sm ${
        selected ? "border-ink shadow-pixel" : row.active ? "border-ink" : "border-line opacity-70"}`}>
      <div className="aspect-square w-full overflow-hidden bg-cream">
        {near ? <BrokerArtwork tokenId={BigInt(row.id)} size={160} /> : <div className="w-full h-full" />}
      </div>
      <div className="flex items-center justify-between mt-1.5">
        <span className="font-pixel text-[10px] text-ink-strong">#{row.id}</span>
        <span className="font-pixel text-[8px] px-1 py-0.5 border"
          style={row.active ? { color: PARTNER_ACCENT, borderColor: PARTNER_ACCENT } : { color: "var(--c-ink-soft)", borderColor: "var(--c-line)" }}>
          {row.active ? "ON" : "OFF"}
        </span>
      </div>
    </button>
  );
}

function SeatPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error" } | { status: "ready"; data: BrokerSnapshot }>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    fetch(`/api/broker/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => { if (alive) setState({ status: "ready", data: j.broker as BrokerSnapshot }); })
      .catch(() => { if (alive) setState({ status: "error" }); });
    return () => { alive = false; };
  }, [id]);
  const d = state.status === "ready" ? state.data : null;
  const stock = d?.holdings.filter((h) => h.symbol !== "COAT") ?? [];
  const owed = d?.claimable.filter((h) => h.symbol !== "COAT") ?? [];
  const inCampaign = d ? d.owner.toLowerCase() === String(CAMPAIGN.wallet).toLowerCase() : false;
  return (
    <div className="card p-4 sm:p-5" role="region" aria-label={`Seat ${id}`}>
      <div className="flex items-start gap-4">
        <div className="shrink-0 border-2 border-ink bg-cream"><BrokerArtwork tokenId={BigInt(id)} size={112} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="font-pixel text-base text-ink-strong">Broker #{id}</h3>
            <button type="button" className="text-ink-soft hover:text-ink-strong font-pixel text-[10px]" onClick={onClose} aria-label="Close seat">CLOSE ✕</button>
          </div>
          {state.status === "loading" && <p className="text-ink-soft text-sm mt-2">Reading the chain…</p>}
          {state.status === "error" && <p className="text-accent text-sm mt-2">Could not read this seat just now. Try again in a moment.</p>}
          {d && (
            <>
              <div className="flex flex-wrap gap-1.5 mt-2">
                <span className="chip">{d.active ? "SWITCHED ON" : "NOT YET SWITCHED ON"}</span>
                {inCampaign && <span className="chip" style={{ color: PARTNER_ACCENT, borderColor: PARTNER_ACCENT }}>{CAMPAIGN.partnerName.toUpperCase()} DESK</span>}
              </div>
              <dl className="mt-3 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div>
                  <dt className="font-pixel text-[10px] uppercase tracking-wider text-ink-soft">Stock in the seat</dt>
                  <dd className="text-ink-strong">{stock.length ? stock.map((h) => `${h.formatted} ${h.symbol}`).join(" · ") : "nothing yet"}</dd>
                </div>
                <div>
                  <dt className="font-pixel text-[10px] uppercase tracking-wider text-ink-soft">Still owed by the engine</dt>
                  <dd className="text-ink-strong">{owed.length ? owed.map((h) => `${h.formatted} ${h.symbol}`).join(" · ") : "nothing pending"}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="font-pixel text-[10px] uppercase tracking-wider text-ink-soft">The seat&rsquo;s own wallet</dt>
                  <dd><a className="font-pixel text-[11px] underline break-all" href={explorerAddress(d.wallet)} target="_blank" rel="noreferrer">{d.wallet}</a></dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2 mt-4">
                <Link className="btn btn-ghost text-[11px]" href={`/card/${id}`}>Open the earnings card</Link>
                <Link className="btn btn-ghost text-[11px]" href={`/start?broker=${id}`}>Open on the start page</Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Desks({ roster, selected, onSelect }: { roster: RosterRow[]; selected: number | null; onSelect: (id: number | null) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const shown = useMemo(() => roster.filter((r) =>
    (filter === "all" || (filter === "on") === r.active) && (q === "" || String(r.id).includes(q))), [roster, filter, q]);
  const counts = { all: roster.length, on: roster.filter((r) => r.active).length, off: roster.filter((r) => !r.active).length };
  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="font-pixel text-sm text-ink-strong">The desks</h2>
        <span className="text-[11px] text-ink-soft">every Broker in the campaign wallet, drawn from the chain</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        {(["all", "on", "off"] as Filter[]).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f}
            className={`font-pixel text-[10px] uppercase tracking-widest px-2.5 py-1.5 border-[1.5px] ${filter === f ? "border-ink bg-ink text-cream" : "border-line text-ink-soft hover:text-ink-strong"}`}>
            {f === "all" ? "all" : f === "on" ? "switched on" : "not yet"} · {counts[f]}
          </button>
        ))}
        <input className="fld !w-40 !py-1.5 !text-sm ml-auto" inputMode="numeric" placeholder="find #" value={q}
          onChange={(e) => setQ(e.target.value.replace(/[^0-9]/g, ""))} aria-label="Find a Broker number" />
      </div>
      {shown.length === 0 ? (
        <p className="text-ink-soft text-sm mt-4">No desk matches that.</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-9 xl:grid-cols-11 gap-2 mt-4">
          {shown.map((r) => <Desk key={r.id} row={r} selected={selected === r.id} onSelect={(id) => onSelect(selected === id ? null : id)} />)}
        </div>
      )}
    </div>
  );
}

/* ───────────── page ───────────── */

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
      fetch(`/api/wallet/${CAMPAIGN.wallet}/brokers?ttl=60`)
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

  // The open seat: from a desk tap, the onboarding form, or ?broker= in the link.
  const [selected, setSelected] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openSeat = useCallback((id: number | null) => {
    setSelected(id);
    if (id !== null) requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);
  useEffect(() => {
    const q = Number(new URLSearchParams(window.location.search).get("broker"));
    if (Number.isInteger(q) && q > 0) setSelected(q);
  }, []);

  if (!showLive) {
    return (
      <div className="card mt-6 p-5">
        <p className="text-ink leading-relaxed">
          A sponsored campaign is in preparation. The desks, which seats are switched on and
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

      <p className="text-lg text-ink-strong leading-relaxed max-w-3xl">
        {CAMPAIGN.seats > 0 ? `${num(CAMPAIGN.seats)} ` : ""}{CAMPAIGN.partnerName} holders each get a seat at the desk.
        A seat is a Coattail Broker held in the campaign wallet and switched on the only way a Broker
        can be: by burning {num(PARAMS.activationBurn)} $COAT. From there it earns like every other
        active Broker, real tokenized stock into its own wallet on Robinhood Chain, bought with trading
        fees from what members of Congress disclose. Your {CAMPAIGN.partnerName} never leaves its chain.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Seats" value={CAMPAIGN.seats > 0 ? num(CAMPAIGN.seats) : (roster ? num(roster.length) : "…")}
          hint={roster ? `${num(roster.length)} Brokers in the campaign wallet` : undefined} />
        <Stat label="Switched on" value={roster ? num(active) : "…"} hint="read from the chain, refreshed every minute" accent />
        <Stat label="$COAT burned" value={roster ? compact(burned) : "…"} hint={`${num(PARAMS.activationBurn)} per activation`} />
        <Stat label="Week" value={calendar ? `${calendar.week} / ${CAMPAIGN.weeks}` : "…"}
          hint={calendar ? (calendar.started ? `${num(calendar.daysLeft)} days left` : "not started yet") : undefined} />
      </div>

      <Onboarding onLookup={openSeat} />

      <div ref={panelRef} className="scroll-mt-24">
        {selected !== null && <SeatPanel id={selected} onClose={() => setSelected(null)} />}
      </div>

      {error && !roster && <p className="text-accent text-sm">Could not read the roster just now. Try again in a moment.</p>}
      {roster && <Desks roster={roster} selected={selected} onSelect={openSeat} />}

      <div className="card p-4 sm:p-5">
        <h2 className="font-pixel text-sm text-ink-strong">Who does what</h2>
        <ul className="list-disc ml-5 space-y-1.5 text-ink text-sm mt-2">
          <li><b>{CAMPAIGN.partnerName}</b> holds the Brokers, switches them on, assigns the seats, runs eligibility
            and pays the campaign rewards. Those rules are theirs and live on their page.</li>
          <li><b>Coattail</b> runs the engine that fills the seats: the fee flow, the basket, the buying and
            the payouts into every Broker wallet. We never hold anyone&rsquo;s rewards.</li>
          <li><b>The chain</b> settles it. Ownership, activation, holdings and every purchase are public.
            {CAMPAIGN.wallet && (
              <> Campaign wallet:{" "}
                <a className="font-pixel text-[11px] break-all underline" href={explorerAddress(CAMPAIGN.wallet)} target="_blank" rel="noreferrer">{CAMPAIGN.wallet}</a>
              </>
            )}
          </li>
        </ul>
        <p className="text-ink-soft text-sm mt-3">
          Be suspicious of anyone who asks you to sign anything on Robinhood Chain for this campaign, or to
          send anything to a wallet. The full mechanics, contract addresses and the open API are on the{" "}
          <Link className="underline" href="/">Docs tab</Link>. Historical, never a forecast. Check the chain.
        </p>
      </div>
    </div>
  );
}

export default function CampaignPage() {
  const live = CAMPAIGN.live && CAMPAIGN.partnerName;
  return (
    <>
      <Header />
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <p className="chip inline-block">SPONSORED DESK</p>
        {live ? (
          <div className="flex items-center gap-4 sm:gap-5 mt-5 flex-wrap">
            <PartnerLogo className="h-10 sm:h-12" />
            <span className="font-pixel text-xl text-ink-soft">×</span>
            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 border-2 border-ink bg-cream-2 grid place-items-center shadow-pixel-sm"><BrokerMark size={22} /></div>
              <div className="font-pixel text-[15px] text-ink-strong leading-none">
                COATTAIL<br />BROKERS
                <span className="block font-sans text-[10px] text-ink-soft tracking-widest mt-0.5">MIRROR CONGRESS</span>
              </div>
            </div>
          </div>
        ) : (
          <h1 className="pixel-title text-xl mt-4">The sponsored desk.</h1>
        )}
        {live && <h1 className="pixel-title text-xl mt-5">The {CAMPAIGN.partnerName} desk.</h1>}
        <CampaignInner />
      </div>
    </>
  );
}
