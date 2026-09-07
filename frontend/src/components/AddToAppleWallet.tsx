"use client";

import { useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { activeChain } from "@/lib/chains";
import { issueMessage } from "@/lib/passkit/message";
import { Icon } from "@/components/ui/Icon";

// "Add to Apple Wallet" for one Broker the connected wallet owns: sign a short message
// (proof you hold the wallet), get a 15-minute link, open it — iOS and macOS Safari then
// show the pass with Apple's own "Add" sheet. The button only appears once the server says
// passes are configured, so nothing dangles before the certificate is in place.

type Status = { apple: boolean; updates: boolean };
let statusPromise: Promise<Status> | null = null;
function passStatus(): Promise<Status> {
  if (!statusPromise) {
    statusPromise = fetch("/api/pass/status")
      .then((r) => (r.ok ? (r.json() as Promise<Status>) : { apple: false, updates: false }))
      .catch(() => ({ apple: false, updates: false }));
  }
  return statusPromise;
}

const isApplePlatform = () =>
  typeof navigator !== "undefined" && /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);

export function AddToAppleWallet({ id }: { id: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [link, setLink] = useState("");

  useEffect(() => {
    let alive = true;
    passStatus().then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, []);

  if (!status?.apple || !address) return null;

  async function add() {
    if (!address) return;
    setBusy(true);
    setMsg("");
    setLink("");
    try {
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const message = issueMessage({ id: Number(id), address, chainId: activeChain.id, expiresAt });
      const signature = await signMessageAsync({ message });
      const res = await fetch(`/api/pass/${id}/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, signature, expiresAt }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? `server ${res.status}`);
      setLink(data.url);
      if (isApplePlatform()) {
        window.location.assign(data.url);
        setMsg("Opening the pass… tap Add when Wallet shows it.");
      } else {
        setMsg("Pass ready. Open the link on your iPhone (or send it to yourself) within 15 minutes.");
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setMsg(/rejected|denied|cancel/i.test(text) ? "Signature cancelled." : `Could not add the pass: ${text}`);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setMsg("Link copied. It works for 15 minutes.");
    } catch {
      setMsg(link);
    }
  }

  return (
    <div className="mt-3">
      <button className="btn btn-ghost w-full" onClick={add} disabled={busy}>
        <Icon name="wallet" /> {busy ? "PREPARING…" : "Add to Apple Wallet"}
      </button>
      {msg && <p className="text-ink-soft text-sm mt-2 break-all">{msg}</p>}
      {link && !isApplePlatform() && (
        <button className="btn btn-ghost w-full mt-2" onClick={copy}>
          Copy pass link
        </button>
      )}
      {status.updates ? (
        <p className="text-ink-soft text-xs mt-2">
          The card updates itself and pings you when payroll lands. It only reads the chain; it cannot move anything.
        </p>
      ) : (
        <p className="text-ink-soft text-xs mt-2">A snapshot card for now; live updates arrive with the next site update.</p>
      )}
    </div>
  );
}
