"use client";

// Discord holder verification page — address-only flow (no wallet connection, no
// signature). Reached via the one-time link the bot hands out in Discord: paste the
// wallet address, the server reads its Broker balance on chain and grants the role.
// One address can only ever verify one Discord account (first-claim lock).

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Header } from "@/components/Header";

type Phase = "ready" | "checking" | "done" | "failed";

function VerifyInner() {
  const params = useSearchParams();
  const state = params.get("state") ?? "";
  const [address, setAddress] = useState("");
  const [phase, setPhase] = useState<Phase>("ready");
  const [detail, setDetail] = useState("");
  const [brokers, setBrokers] = useState(0);

  async function verify() {
    try {
      setPhase("checking");
      const res = await fetch("/api/discord/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, address: address.trim() }),
      });
      const j = await res.json();
      if (j.ok) { setBrokers(j.brokers); setPhase("done"); }
      else { setDetail(j.error ?? "verification failed"); setPhase("failed"); }
    } catch {
      setDetail("network error — try again");
      setPhase("failed");
    }
  }

  if (!state) {
    return (
      <div className="card mt-6">
        <p className="text-ink">
          This page only works from a verification link. Run{" "}
          <b className="text-ink-strong">/verify</b> in the Discord server to get yours.
        </p>
      </div>
    );
  }

  return (
    <div className="card mt-6">
      {phase === "done" ? (
        <p className="text-ink">
          <b className="text-good">Verified.</b> {brokers} Broker{brokers === 1 ? "" : "s"} found —
          your Brokerage role is live in Discord. You can close this page.
        </p>
      ) : (
        <>
          <label className="label" htmlFor="addr">Your wallet address</label>
          <input
            id="addr" className="fld" placeholder="0x…" value={address} spellCheck={false}
            onChange={(e) => { setAddress(e.target.value); if (phase === "failed") setPhase("ready"); }}
          />
          {phase === "failed" && (
            <p className="text-accent text-sm mt-2">{detail}</p>
          )}
          <button
            className="btn btn-accent mt-4"
            onClick={verify}
            disabled={phase === "checking" || address.trim().length < 10}
          >
            {phase === "checking" ? "Checking the chain…" : "Verify"}
          </button>
          <p className="text-ink-soft text-[11px] mt-4">
            We only read the address&rsquo;s public Broker balance — nothing to connect,
            nothing to sign, nothing to approve. Each address can verify one Discord
            account, and a daily sweep removes the role if the Brokers leave the wallet.
          </p>
        </>
      )}
    </div>
  );
}

export default function VerifyPage() {
  return (
    <>
      <Header />
      <div className="max-w-xl mx-auto px-4 py-10">
        <p className="chip inline-block">DISCORD VERIFICATION</p>
        <h1 className="pixel-title text-xl mt-4">Prove you hold a Broker.</h1>
        <p className="text-ink mt-3 leading-relaxed">
          Paste your wallet address — we check its Broker balance on chain and hand you
          the Brokerage role in Discord.
        </p>
        <Suspense fallback={<p className="text-ink-soft mt-6">Loading…</p>}>
          <VerifyInner />
        </Suspense>
      </div>
    </>
  );
}
