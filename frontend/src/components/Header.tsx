"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { BrokerMark } from "./ui/BrokerMark";
import { short } from "@/lib/format";
import { wagmiConfig } from "@/lib/wagmi";

export function Header() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [restoreTimedOut, setRestoreTimedOut] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const { address, isConnected, status } = useAccount();
  const { connectors, connectAsync, error, isPending, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const busy = !mounted || isPending || (status === "reconnecting" && !restoreTimedOut);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (status !== "reconnecting") {
      setRestoreTimedOut(false);
      return;
    }
    // A wallet extension may retain a dead persisted session after a refresh. Never leave the
    // only connect button disabled indefinitely; reset the stale wagmi connection after 3s.
    const timer = window.setTimeout(() => {
      wagmiConfig.setState((state) => ({ ...state, connections: new Map(), current: null, status: "disconnected" }));
      setRestoreTimedOut(true);
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [status]);

  async function connectWallet(connector: (typeof connectors)[number]) {
    reset();
    setWalletError(null);
    try {
      await connectAsync({ connector });
      setOpen(false);
    } catch (cause) {
      // A persisted connector uid can survive with no matching connection after an interrupted
      // hydration. Clear only wagmi's stale in-memory pointer (do not revoke wallet permission),
      // then establish the already-authorized provider as a fresh connection.
      if (cause instanceof Error && cause.name === "ConnectorAlreadyConnectedError") {
        try {
          wagmiConfig.setState((state) => ({
            ...state,
            connections: new Map(),
            current: null,
            status: "disconnected",
          }));
          await connectAsync({ connector });
          reset();
          setOpen(false);
        } catch (reconnectCause) {
          setWalletError(reconnectCause instanceof Error ? reconnectCause.message : "Wallet reconnect failed");
        }
        return;
      }
      setWalletError(cause instanceof Error ? cause.message : "Wallet connection failed");
    }
  }
  return (
    <header className="sticky top-0 z-20 bg-cream border-b-2 border-ink">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-[34px] h-[34px] border-2 border-ink bg-cream-2 shadow-pixel-sm grid place-items-center">
            <BrokerMark size={20} />
          </div>
          <div className="font-pixel text-[15px] text-ink-strong leading-none">
            COATTAIL<br />BROKERS
            <span className="block font-sans text-[10px] text-ink-soft tracking-widest mt-0.5">
              MIRROR CONGRESS
            </span>
          </div>
        </div>
        <button className="btn btn-ghost shadow-pixel-sm" disabled={busy}
          onClick={() => isConnected ? disconnect() : setOpen(true)}>
          {busy ? "RESTORING…" : isConnected && address ? short(address) : "CONNECT WALLET"}
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-50 bg-ink/40 grid place-items-center p-4" onMouseDown={() => setOpen(false)}>
          <div className="card w-full max-w-sm" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h2 className="pixel-title text-sm">Connect wallet</h2>
              <button className="btn btn-ghost" onClick={() => setOpen(false)}>×</button>
            </div>
            <div className="grid gap-2">
              {connectors.map((connector) => (
                <button key={connector.uid} className="btn btn-ghost w-full" disabled={busy}
                  onClick={() => void connectWallet(connector)}>
                  {connector.name}
                </button>
              ))}
            </div>
            {(walletError || error) && (
              <p className="text-accent text-sm mt-3">{walletError ?? error?.message}</p>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
