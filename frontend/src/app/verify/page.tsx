"use client";

// Discord holder verification — OpenSea-bio ownership proof, no wallet connection.
// Flow: paste address -> get a one-time code -> put it in the OpenSea profile bio
// (editing that bio requires signing in to OpenSea with the wallet, which is the
// actual proof) -> check -> Brokerage role. The code can be removed afterwards.

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Header } from "@/components/Header";

type Phase = "address" | "code" | "checking" | "done" | "failed";

function VerifyInner() {
  const params = useSearchParams();
  const state = params.get("state") ?? "";
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<Phase>("address");
  const [detail, setDetail] = useState("");
  const [brokers, setBrokers] = useState(0);
  const [copied, setCopied] = useState(false);

  async function getCode() {
    setDetail("");
    try {
      const res = await fetch(
        `/api/discord/verify?state=${encodeURIComponent(state)}&address=${encodeURIComponent(address.trim())}`);
      const j = await res.json();
      if (j.ok) { setCode(j.code); setPhase("code"); }
      else setDetail(j.error ?? "failed");
    } catch {
      setDetail("network error — try again");
    }
  }

  async function check() {
    try {
      setPhase("checking");
      const res = await fetch("/api/discord/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, address: address.trim() }),
      });
      const j = await res.json();
      if (j.ok) { setBrokers(j.brokers); setPhase("done"); }
      else { setDetail(j.error ?? "verification failed"); setPhase(j.code ? "code" : "failed"); }
    } catch {
      setDetail("network error — try again");
      setPhase("code");
    }
  }

  if (!state) {
    return (
      <div className="card mt-6">
        <p className="text-ink">
          This page only works from a verification link. Run{" "}
          <b className="text-ink-strong">/verify</b> in the Discord server (or press the
          Verify button there) to get yours.
        </p>
      </div>
    );
  }

  return (
    <div className="card mt-6">
      {phase === "done" ? (
        <p className="text-ink">
          <b className="text-good">Verified.</b> {brokers} Broker{brokers === 1 ? "" : "s"} found —
          your Brokerage role is live in Discord. You can now remove the code from your
          OpenSea bio.
        </p>
      ) : phase === "address" ? (
        <>
          <label className="label" htmlFor="addr">Step 1 — your wallet address</label>
          <input
            id="addr" className="fld" placeholder="0x…" value={address} spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
          />
          {detail && <p className="text-accent text-sm mt-2">{detail}</p>}
          <button className="btn btn-accent mt-4" onClick={getCode} disabled={address.trim().length < 10}>
            Get my code
          </button>
        </>
      ) : (
        <>
          <p className="label">Step 2 — prove the wallet is yours</p>
          <p className="text-ink text-sm leading-relaxed">
            Add this code anywhere in your{" "}
            <a className="underline" href={`https://opensea.io/${address.trim()}`} target="_blank"
              rel="noopener noreferrer">OpenSea profile</a>{" "}
            bio and save (profile → settings → bio). Only the wallet&rsquo;s owner can edit
            that bio — that&rsquo;s the proof. You can delete it right after.
          </p>
          <div className="flex gap-2 mt-3 items-center">
            <code className="fld font-pixel text-[13px] select-all">{code}</code>
            <button
              className="btn btn-ghost shrink-0 text-[11px] px-3 py-2.5"
              onClick={() => { navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            >
              {copied ? "COPIED" : "COPY"}
            </button>
          </div>
          {detail && <p className="text-accent text-sm mt-3">{detail}</p>}
          <button className="btn btn-accent mt-4" onClick={check} disabled={phase === "checking"}>
            {phase === "checking" ? "Checking your bio…" : "I added it — check"}
          </button>
          <button className="btn btn-ghost mt-4 ml-2 text-[11px] px-3 py-2.5"
            onClick={() => { setPhase("address"); setDetail(""); }}>
            change address
          </button>
        </>
      )}
      {phase !== "done" && (
        <p className="text-ink-soft text-[11px] mt-4">
          We never ask you to connect a wallet, sign, or approve anything here. The daily
          sweep removes the role if the Brokers leave the wallet.
        </p>
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
          Two steps: paste your address, then drop a one-time code into your OpenSea bio.
          Editing that bio takes the wallet&rsquo;s own OpenSea login — that&rsquo;s your proof,
          and it never happens on our site.
        </p>
        <Suspense fallback={<p className="text-ink-soft mt-6">Loading…</p>}>
          <VerifyInner />
        </Suspense>
      </div>
    </>
  );
}
