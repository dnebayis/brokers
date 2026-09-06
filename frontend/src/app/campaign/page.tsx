"use client";

// The sponsored desk: one community's holders, each given a seat that is a Broker in the
// campaign wallet. The whole participant journey lives on this one page: what a seat is,
// opening yours, watching it earn, what happens at the end. Everything shown is read live
// from the open Broker API (roster, which seats are switched on, what each seat holds) or
// derived from it. The rules, eligibility and rewards are the partner's and live on their
// page; this page never restates them, and only points there where joining or claiming
// genuinely happens on their side. `?broker=N` opens a seat; `?preview=1` renders the
// layout with placeholder data when the campaign is switched off.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
type Scorecard = {
  ok: boolean; generatedAt: string; purchases: number;
  names: { symbol: string; buys: number; lastBuy: number }[];
};
type SeatState = { status: "idle" } | { status: "loading" } | { status: "error" } | { status: "ready"; data: BrokerSnapshot; at: number };

// The partner's brand colour, used only where the page speaks about their side.
const PARTNER_ACCENT = "#ff8a1f";
const PARTNER_LOGO = "/partners/geez.png";
const SEAT_KEY = "coattail.campaign.seat";

const PREVIEW_ROSTER: RosterRow[] = Array.from({ length: 100 }, (_, i) => ({
  id: 101 + i * 7,
  active: i % 5 !== 4,
  wallet: "0x0000000000000000000000000000000000000000",
}));

const num = (n: number) => n.toLocaleString("en-US");
const compact = (n: number) => n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };

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

/** One seat, read from the open Broker API; `reload()` re-reads it and stamps the time. */
function useSeat(id: number | null): { state: SeatState; reload: () => void } {
  const [state, setState] = useState<SeatState>({ status: "idle" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (id === null) { setState({ status: "idle" }); return; }
    let alive = true;
    setState((s) => (s.status === "ready" && s.data.id === id ? s : { status: "loading" }));
    fetch(`/api/broker/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => { if (alive) setState({ status: "ready", data: j.broker as BrokerSnapshot, at: Date.now() }); })
      .catch(() => { if (alive) setState({ status: "error" }); });
    return () => { alive = false; };
  }, [id, tick]);
  return { state, reload: () => setTick((t) => t + 1) };
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

function Tile({ k, v, accent, wide }: { k: string; v: React.ReactNode; accent?: boolean; wide?: boolean }) {
  return (
    <div className={`border border-line bg-cream p-3 ${wide ? "col-span-2" : ""}`}>
      <div className="font-pixel text-[10px] uppercase tracking-wider" style={{ color: accent ? PARTNER_ACCENT : "var(--c-ink-soft)" }}>{k}</div>
      <div className="font-pixel text-[12px] text-ink-strong mt-1 leading-relaxed">{v}</div>
    </div>
  );
}

/* ───────────── the seat card (used inside the journey) ───────────── */

function SeatCard({ id, seat, onReload }: { id: number; seat: SeatState; onReload: () => void }) {
  const d = seat.status === "ready" ? seat.data : null;
  const stock = d?.holdings.filter((h) => h.symbol !== "COAT") ?? [];
  const owed = d?.claimable.filter((h) => h.symbol !== "COAT") ?? [];
  const inCampaign = d ? d.owner.toLowerCase() === String(CAMPAIGN.wallet).toLowerCase() : false;
  return (
    <div className="border-2 border-ink bg-cream p-3 sm:p-4" role="region" aria-label={`Seat ${id}`}>
      <div className="flex items-start gap-4">
        <div className="shrink-0 border-2 border-ink bg-cream-2"><BrokerArtwork tokenId={BigInt(id)} size={112} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="font-pixel text-base text-ink-strong">Broker #{id}</h3>
            <button type="button" className="font-pixel text-[10px] text-ink-soft hover:text-ink-strong inline-flex items-center gap-1" onClick={onReload}>
              <Icon name="flip" className="w-3 h-3" /> {seat.status === "ready" ? `as of ${clock(seat.at)} · refresh` : "refresh"}
            </button>
          </div>
          {seat.status === "loading" && <p className="text-ink-soft text-sm mt-2">Reading the chain…</p>}
          {seat.status === "error" && <p className="text-accent text-sm mt-2">Could not read this seat just now. Try again in a moment.</p>}
          {d && (
            <>
              <div className="flex flex-wrap gap-1.5 mt-2">
                <span className="chip">{d.active ? "SWITCHED ON" : "NOT YET SWITCHED ON"}</span>
                {inCampaign
                  ? <span className="chip" style={{ color: PARTNER_ACCENT, borderColor: PARTNER_ACCENT }}>{CAMPAIGN.partnerName.toUpperCase()} DESK</span>
                  : <span className="chip">NOT IN THE CAMPAIGN WALLET</span>}
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
                  <dt className="font-pixel text-[10px] uppercase tracking-wider text-ink-soft">The seat&rsquo;s own wallet, on the explorer</dt>
                  <dd><a className="font-pixel text-[11px] underline break-all" href={explorerAddress(d.wallet)} target="_blank" rel="noreferrer">{d.wallet}</a></dd>
                </div>
              </dl>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────── the journey ───────────── */

function Journey({ seatId, onSeat, seat, reloadSeat, calendar, active }: {
  seatId: number | null; onSeat: (id: number) => void; seat: SeatState; reloadSeat: () => void;
  calendar: { week: number; daysLeft: number; started: boolean } | null; active: number;
}) {
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState("");
  // A seat arriving from a link, a desk tap or the last visit moves the journey to it.
  useEffect(() => { if (seatId !== null) { setTyped(String(seatId)); setStep((s) => (s < 1 ? 1 : s)); } }, [seatId]);

  // Desk-wide context for "watch it earn": how often the engine has been buying.
  const [sc, setSc] = useState<Scorecard | null>(null);
  useEffect(() => {
    if (step !== 2 || sc) return;
    fetch("/api/scorecard").then((r) => (r.ok ? r.json() : Promise.reject())).then((j) => setSc(j as Scorecard)).catch(() => {});
  }, [step, sc]);
  const lastBuy = sc ? Math.max(0, ...sc.names.map((n) => n.lastBuy)) : 0;

  const seatReady = seat.status === "ready";
  const titles = ["What a seat is", "Open your seat", "Watch it earn", "At the end"];
  const go = (i: number) => setStep(Math.max(0, Math.min(titles.length - 1, i)));
  const canNext = step === 0 || (step === 1 && seatReady) || step === 2;
  const partnerHost = CAMPAIGN.partnerUrl ? hostOf(CAMPAIGN.partnerUrl) : "";

  return (
    <div className="card p-4 sm:p-5" id="journey">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="font-pixel text-sm text-ink-strong">Your seat, step by step</h2>
        <span className="text-[11px] text-ink-soft">everything here reads from the chain, nothing to sign</span>
      </div>
      <ol className="mt-3 grid grid-cols-4 gap-1.5" role="tablist" aria-label="Steps">
        {titles.map((t, i) => {
          const on = i === step, done = i < step;
          return (
            <li key={t}>
              <button type="button" role="tab" aria-selected={on} onClick={() => go(i)}
                className={`w-full text-left border-2 px-2 py-2 transition-colors ${on ? "border-ink bg-ink text-cream" : done ? "border-ink bg-cream-3 text-ink-strong" : "border-line bg-cream-2 text-ink-soft hover:text-ink-strong"}`}>
                <span className="font-pixel text-[10px] block">{done ? "✓ " : ""}{i + 1}</span>
                <span className="text-[11px] leading-tight block mt-0.5">{t}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="mt-4 border-l-[3px] border-ink pl-4">
        {step === 0 && (
          <div>
            <h3 className="font-pixel text-[12px] text-ink-strong">A seat is a Broker that works for you.</h3>
            <div className="grid sm:grid-cols-3 gap-2 mt-3">
              {[
                { k: `Your ${CAMPAIGN.partnerName}`, v: "stays staked on its own chain. It never moves, never gets wrapped or bridged.", accent: true },
                { k: "The Broker", v: `is held in the campaign wallet and switched on by burning ${num(PARAMS.activationBurn)} $COAT. That is the only way a Broker turns on.` },
                { k: "The seat's wallet", v: "is the Broker's own on-chain wallet. Every hour the engine can, it drops tokenized stock in there. It stays there." },
              ].map((c) => (
                <div key={c.k} className="border border-line bg-cream p-3">
                  <div className="font-pixel text-[10px] uppercase tracking-wider" style={{ color: c.accent ? PARTNER_ACCENT : "var(--c-ink-soft)" }}>{c.k}</div>
                  <p className="text-sm text-ink mt-1 leading-relaxed">{c.v}</p>
                </div>
              ))}
            </div>
            <p className="text-sm text-ink mt-3 leading-relaxed max-w-3xl">
              What the engine buys is whatever members of Congress are disclosing as buys, paid for with
              the fees of every $COAT trade and split equally across every switched-on Broker. Right now
              there are <b className="text-ink-strong">{num(active)}</b> switched on across this desk.
            </p>
            <details className="mt-3">
              <summary className="cursor-pointer list-none font-pixel text-[11px] text-ink-soft hover:text-ink-strong [&::-webkit-details-marker]:hidden">
                ▸ Don&rsquo;t have a seat yet?
              </summary>
              <p className="text-sm text-ink mt-2 leading-relaxed max-w-3xl">
                Seats are handed out by {CAMPAIGN.partnerName}, on their site, to their holders, by their
                rules. Nothing about joining happens here.
                {partnerHost && <> Their campaign page: <a className="underline" href={CAMPAIGN.partnerUrl} target="_blank" rel="noreferrer">{partnerHost}</a>.</>}
              </p>
            </details>
          </div>
        )}

        {step === 1 && (
          <div>
            <h3 className="font-pixel text-[12px] text-ink-strong">Type your seat number, or tap a desk below.</h3>
            <form className="flex flex-wrap gap-2 mt-3 max-w-md" onSubmit={(e) => { e.preventDefault(); const n = Number(typed); if (n > 0) onSeat(n); }}>
              <input className="fld flex-1 min-w-[9rem]" inputMode="numeric" placeholder={`Broker number, 1 to ${num(PARAMS.maxSupply)}`} value={typed}
                onChange={(e) => setTyped(e.target.value.replace(/[^0-9]/g, ""))} aria-label="Broker number" />
              <button className="btn text-[11px]" type="submit"><Icon name="search" /> Open</button>
            </form>
            {seatId !== null
              ? <div className="mt-3"><SeatCard id={seatId} seat={seat} onReload={reloadSeat} /></div>
              : <p className="text-ink-soft text-sm mt-3">No wallet, no sign-in. The seat is read straight from the chain and remembered on this device.</p>}
          </div>
        )}

        {step === 2 && (
          <div>
            <h3 className="font-pixel text-[12px] text-ink-strong">This is what earning looks like.</h3>
            <p className="text-sm text-ink mt-2 leading-relaxed max-w-3xl">
              Every $COAT trade pays a fee. When enough has come in, the engine buys the basket and every
              switched-on Broker is owed an equal slice. &ldquo;Still owed&rdquo; is the slice sitting in the engine
              for this seat; &ldquo;stock in the seat&rdquo; is what has already been pulled into its wallet. Both
              are yours to watch, neither needs anything from you.
            </p>
            {sc && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
                <Tile k="engine purchases" v={num(sc.purchases)} />
                <Tile k="last purchase" v={lastBuy ? clock(lastBuy * 1000) : "—"} />
                <Tile k="names bought so far" wide v={[...sc.names].sort((a, b) => b.buys - a.buys).map((n) => n.symbol).join(" · ")} />
              </div>
            )}
            {seatId !== null
              ? <div className="mt-3"><SeatCard id={seatId} seat={seat} onReload={reloadSeat} /></div>
              : <p className="text-ink-soft text-sm mt-3">Open a seat in step 2 to see its own numbers here.</p>}
            <p className="text-[11px] text-ink-soft mt-3">Quiet trading means quiet earnings. There is no fixed rate and nothing is promised; the chain is the record.</p>
          </div>
        )}

        {step === 3 && (
          <div>
            <h3 className="font-pixel text-[12px] text-ink-strong">The seat runs for {CAMPAIGN.weeks} weeks.</h3>
            <div className="grid grid-cols-3 gap-2 mt-3 max-w-xl">
              <Tile k="opened" v={CAMPAIGN.startDate ? dayLabel(CAMPAIGN.startDate) : "—"} />
              <Tile k="closes" v={CAMPAIGN.endDate ? dayLabel(CAMPAIGN.endDate) : "—"} />
              <Tile k="days left" accent v={calendar ? num(calendar.daysLeft) : "—"} />
            </div>
            <ul className="list-disc ml-5 space-y-1.5 text-sm text-ink mt-3 max-w-3xl">
              <li>Until then the seat keeps earning into its own wallet; come back to this page any time and it will remember your seat.</li>
              <li>What the seat earned stays on Robinhood Chain in the Broker&rsquo;s wallet. The Broker belongs to the {CAMPAIGN.partnerName} Treasury throughout.</li>
              <li>Claiming, eligibility and the extra rewards are {CAMPAIGN.partnerName}&rsquo;s side of the desk, after their final check. Their page has the exact rules{partnerHost && <>: <a className="underline" href={CAMPAIGN.partnerUrl} target="_blank" rel="noreferrer">{partnerHost}</a></>}.</li>
              <li>Nobody will ever ask you to sign anything on Robinhood Chain for this. If someone does, it is not us and it is not them.</li>
            </ul>
          </div>
        )}
      </div>

      <div className="flex justify-between mt-4">
        <button type="button" className="btn btn-ghost text-[11px]" disabled={step === 0} onClick={() => go(step - 1)}>Back</button>
        <button type="button" className="btn text-[11px]" disabled={!canNext || step === titles.length - 1} onClick={() => go(step + 1)}>
          {step === 1 && !seatReady ? "Open a seat first" : "Next"} <Icon name="arrow-right" />
        </button>
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

function Desks({ roster, selected, onSelect }: { roster: RosterRow[]; selected: number | null; onSelect: (id: number) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const shown = useMemo(() => roster.filter((r) =>
    (filter === "all" || (filter === "on") === r.active) && (q === "" || String(r.id).includes(q))), [roster, filter, q]);
  const counts = { all: roster.length, on: roster.filter((r) => r.active).length, off: roster.filter((r) => !r.active).length };
  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="font-pixel text-sm text-ink-strong">The desks</h2>
        <span className="text-[11px] text-ink-soft">every Broker in the campaign wallet, drawn from the chain · tap one to open it above</span>
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
          {shown.map((r) => <Desk key={r.id} row={r} selected={selected === r.id} onSelect={onSelect} />)}
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
      fetch(`/api/wallet/${CAMPAIGN.wallet}/brokers?ttl=60&v=2`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => {
          if (!alive) return;
          const rows: RosterRow[] = d.brokers ?? [];
          // A roster that came back empty while the last one was full is a bad read, not a
          // desk that emptied overnight: keep what we have and try again next minute.
          setRoster((prev) => (rows.length === 0 && prev && prev.length > 0 ? prev : rows));
          setError(rows.length === 0);
        })
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

  // The open seat: from a desk tap, the journey's form, a ?broker= link, or the last visit.
  const [seatId, setSeatId] = useState<number | null>(null);
  const journeyRef = useRef<HTMLDivElement>(null);
  const openSeat = useCallback((id: number, scroll = false) => {
    setSeatId(id);
    try { window.localStorage.setItem(SEAT_KEY, String(id)); } catch { /* best-effort */ }
    if (scroll) requestAnimationFrame(() => journeyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);
  useEffect(() => {
    const q = Number(new URLSearchParams(window.location.search).get("broker"));
    if (Number.isInteger(q) && q > 0) { openSeat(q); return; }
    try {
      const saved = Number(window.localStorage.getItem(SEAT_KEY));
      if (Number.isInteger(saved) && saved > 0) setSeatId(saved);
    } catch { /* no storage, no memory */ }
  }, [openSeat]);
  const { state: seat, reload: reloadSeat } = useSeat(seatId);

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

      <div ref={journeyRef} className="scroll-mt-24">
        <Journey seatId={seatId} onSeat={(id) => openSeat(id)} seat={seat} reloadSeat={reloadSeat} calendar={calendar} active={active} />
      </div>

      {error && !(roster && roster.length > 0) && <p className="text-accent text-sm">Could not read the roster just now. It retries every minute.</p>}
      {roster && roster.length > 0 && <Desks roster={roster} selected={seatId} onSelect={(id) => openSeat(id, true)} />}

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
        <p className="text-ink-soft text-sm mt-3">Historical, never a forecast. Check the chain.</p>
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
