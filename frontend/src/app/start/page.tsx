"use client";

// Onboarding for someone whose community sponsored a seat at the desk: they do not hold the
// Broker (the sponsor's campaign wallet does), so the usual "connect and activate" flow does
// not apply to them. What they need is what the seat is, what it is earning right now, and
// which parts are the sponsor's job rather than ours. No wallet, no keys: the id lookup runs
// against the open Broker API.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Header } from "@/components/Header";
import { BrokerArtwork } from "@/components/ui/BrokerArtwork";
import { explorerAddress } from "@/lib/chains";
import { PARAMS } from "@/lib/config";

type Holding = { token: string; symbol: string; decimals: number; amount: string; formatted: string };
type BrokerData = {
  id: number;
  owner: string;
  wallet: string;
  active: boolean;
  claimable: Holding[];
  holdings: Holding[];
};
type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "missing" }
  | { status: "unreachable" }
  | { status: "ready"; data: BrokerData };

const MAX_SUPPLY = PARAMS.maxSupply;

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-b-0">
      <span className="font-pixel text-[10px] uppercase tracking-wider text-ink-soft">{label}</span>
      <span className="text-sm text-ink-strong text-right">{value}</span>
    </div>
  );
}

function Seat({ data }: { data: BrokerData }) {
  // COAT rides in the same wallet as the stock but is not stock: separate it so a seat's
  // earnings are not overstated by an activation-fuel balance someone dropped in.
  const stock = data.holdings.filter((h) => h.symbol !== "COAT");
  const coat = data.holdings.find((h) => h.symbol === "COAT");
  const owed = data.claimable.filter((h) => h.symbol !== "COAT");
  return (
    <div className="card p-4 mt-4">
      <div className="flex items-start gap-4">
        <BrokerArtwork tokenId={BigInt(data.id)} size={96} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-pixel text-lg text-ink-strong">Broker #{data.id}</h2>
            <span className="chip">{data.active ? "SWITCHED ON" : "NOT YET SWITCHED ON"}</span>
          </div>
          <div className="mt-3">
            <Row label="Stock in the seat" value={
              stock.length === 0 ? "nothing yet" :
                stock.map((h) => `${h.formatted} ${h.symbol}`).join("  ·  ")} />
            <Row label="Still owed by the engine" value={
              owed.length === 0 ? "nothing pending" :
                owed.map((h) => `${h.formatted} ${h.symbol}`).join("  ·  ")} />
            <Row label="$COAT in the seat" value={coat ? `${Number(coat.formatted).toLocaleString("en-US", { maximumFractionDigits: 0 })} $COAT` : "none"} />
            <Row label="The seat's own wallet" value={
              <a className="font-pixel text-[11px] underline break-all" href={explorerAddress(data.wallet)}
                target="_blank" rel="noreferrer">{data.wallet.slice(0, 10)}…{data.wallet.slice(-6)}</a>} />
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
        <Link className="btn btn-ghost text-[11px]" href={`/card/${data.id}`}>Open the earnings card</Link>
        <Link className="btn btn-ghost text-[11px]" href="/campaign">See the whole desk</Link>
      </div>
      {!data.active && (
        <p className="text-ink-soft text-sm mt-3">
          This seat is not earning yet. Switching it on burns {PARAMS.activationBurn.toLocaleString("en-US")} $COAT
          and is done by whoever holds the Broker, which in a sponsored campaign is the sponsor, not you.
        </p>
      )}
    </div>
  );
}

export default function StartPage() {
  const [id, setId] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });

  const lookup = useCallback(async (raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SUPPLY) { setState({ status: "missing" }); return; }
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/broker/${n}`);
      if (res.status === 404) { setState({ status: "missing" }); return; }
      if (!res.ok) { setState({ status: "unreachable" }); return; }
      const json = await res.json();
      setState({ status: "ready", data: json.broker as BrokerData });
    } catch {
      // A failed request is the network, not a missing Broker: saying "no such Broker" here
      // would tell a participant their seat does not exist when it plainly does.
      setState({ status: "unreachable" });
    }
  }, []);

  // A link can carry the seat: /start?broker=301 opens straight on that Broker.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("broker");
    if (q) { setId(q); void lookup(q); }
  }, [lookup]);

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto px-4 py-10">
        <p className="chip inline-block">START HERE</p>
        <h1 className="pixel-title text-xl mt-4">You have a seat at the desk.</h1>
        <p className="text-ink leading-relaxed mt-4">
          A Coattail Broker is a working desk on Robinhood Chain. When it is switched on it earns
          tokenized stock, the same names members of Congress are disclosing as buys, paid out of
          trading fees rather than promises. In a sponsored campaign your community holds the
          Broker and switches it on for you, and a seat is assigned to you for the campaign.
        </p>

        <div className="card p-4 mt-6">
          <h2 className="font-pixel text-sm text-ink-strong">Look up your seat</h2>
          <p className="text-ink-soft text-sm mt-1">
            Your sponsor gives you a Broker number. Everything below is read live from the chain,
            no wallet and no sign-in.
          </p>
          <form className="flex flex-wrap gap-2 mt-3"
            onSubmit={(e) => { e.preventDefault(); void lookup(id); }}>
            <input className="fld flex-1 min-w-[10rem]" inputMode="numeric" value={id}
              onChange={(e) => setId(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder={`Broker number, 1 to ${MAX_SUPPLY.toLocaleString("en-US")}`}
              aria-label="Broker number" />
            <button className="btn" type="submit" disabled={state.status === "loading"}>
              {state.status === "loading" ? "Reading the chain…" : "Look it up"}
            </button>
          </form>
          {state.status === "missing" && (
            <p className="text-accent text-sm mt-3">
              No Broker with that number. Ids run from 1 to {MAX_SUPPLY.toLocaleString("en-US")}.
            </p>
          )}
          {state.status === "unreachable" && (
            <p className="text-accent text-sm mt-3">
              Could not reach the chain just now. Try again in a moment, nothing is wrong with your seat.
            </p>
          )}
        </div>

        {state.status === "ready" && <Seat data={state.data} />}

        <div className="card p-4 mt-6">
          <h2 className="font-pixel text-sm text-ink-strong">How the earning works</h2>
          <ol className="list-decimal ml-5 space-y-1.5 text-ink text-sm mt-2">
            <li>Every $COAT trade pays a 1% fee. That fee is not a treasury, it buys tokenized stock.</li>
            <li>An indexer reads congressional disclosures, builds a basket from what is being bought,
              and the engine buys that basket with the fees that came in.</li>
            <li>The stock is split <b>equally across every switched-on Broker</b>, yours included. The
              split is fixed in the contract, so nobody can weight it toward anyone.</li>
            <li>Your seat&apos;s share lands in that Broker&apos;s own wallet on chain. You can watch it
              here whenever you like; it never expires and nothing needs claiming from you.</li>
          </ol>
        </div>

        <div className="card p-4 mt-4">
          <h2 className="font-pixel text-sm text-ink-strong">Who does what</h2>
          <ul className="list-disc ml-5 space-y-1.5 text-ink text-sm mt-2">
            <li><b>Your community</b> holds the Brokers, switches them on, decides which seat is yours,
              runs the eligibility rules, and pays out the campaign rewards. Those rules and payouts
              are theirs, so ask them about anything to do with your allocation.</li>
            <li><b>Coattail</b> runs the engine that fills the seats: the fee flow, the basket, the
              buying and the payouts into every Broker wallet. We never hold your rewards.</li>
            <li><b>The chain</b> settles it. Ownership, activation, holdings and every purchase are
              public: the seat above links to the explorer, and the whole desk is on the campaign page.</li>
          </ul>
        </div>

        <div className="card p-4 mt-4">
          <h2 className="font-pixel text-sm text-ink-strong">Worth knowing</h2>
          <ul className="list-disc ml-5 space-y-1.5 text-ink text-sm mt-2">
            <li>The Broker is not in your wallet during the campaign, so on Robinhood Chain there is
              nothing for you to sign, approve or pay. Joining happens on your community&apos;s own
              site, on their chain, by their rules. Be suspicious of anyone who asks you to sign
              anything here, or to send anything to a wallet.</li>
            <li>Earnings are funded by trading activity, so they rise and fall with it. There is no
              fixed rate and nothing is guaranteed.</li>
            <li>If a Broker ever does land in your wallet, it arrives switched off: a transfer
              deactivates it by design, and whoever holds it can switch it back on.</li>
          </ul>
          <p className="text-ink-soft text-sm mt-3">
            The full mechanics, contract addresses and the open API are on the{" "}
            <Link className="underline" href="/">Docs tab</Link> of the site.
          </p>
        </div>
      </div>
    </>
  );
}
