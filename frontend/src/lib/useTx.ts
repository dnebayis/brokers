"use client";

import { useEffect, useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { activeChain } from "./chains";
import { parseErr } from "./format";
import { txEvents } from "./client";
import type { StatusKind } from "@/components/ui/Status";

// Shared transaction runner: guards connection + network, surfaces status, and
// centralises error handling. `fn` reports progress via `setStatus`.
export function useTx() {
  const { isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [msg, setMsg] = useState("");
  const [kind, setKind] = useState<StatusKind>("");
  const [busy, setBusy] = useState(false);
  // The hash of the latest transaction this run sent, for the explorer link. Runners are
  // disabled while busy, so a hash announced during a run belongs to that run.
  const [hash, setHash] = useState<`0x${string}` | undefined>(undefined);
  useEffect(() => {
    if (!busy) return;
    const onSent = (e: Event) => setHash((e as CustomEvent<`0x${string}`>).detail);
    txEvents.addEventListener("sent", onSent);
    return () => txEvents.removeEventListener("sent", onSent);
  }, [busy]);

  const setStatus = (m: string, k: StatusKind = "") => {
    setMsg(m);
    setKind(k);
  };

  async function run(fn: () => Promise<void>) {
    if (!isConnected) return setStatus("Connect your wallet first.", "err");
    try {
      setHash(undefined);
      setBusy(true);
      if (chainId !== activeChain.id) await switchChainAsync({ chainId: activeChain.id });
      await fn();
    } catch (e) {
      setStatus(parseErr(e), "err");
    } finally {
      setBusy(false);
    }
  }

  return { run, busy, msg, kind, setStatus, hash };
}
