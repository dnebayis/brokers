"use client";

import { useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { activeChain } from "./chains";
import { parseErr } from "./format";
import type { StatusKind } from "@/components/ui/Status";

// Shared transaction runner: guards connection + network, surfaces status, and
// centralises error handling. `fn` reports progress via `setStatus`.
export function useTx() {
  const { isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [msg, setMsg] = useState("");
  const [kind, setKind] = useState<StatusKind>("");
  const [busy, setBusy] = useState(false);

  const setStatus = (m: string, k: StatusKind = "") => {
    setMsg(m);
    setKind(k);
  };

  async function run(fn: () => Promise<void>) {
    if (!isConnected) return setStatus("Connect your wallet first.", "err");
    try {
      setBusy(true);
      if (chainId !== activeChain.id) await switchChainAsync({ chainId: activeChain.id });
      await fn();
    } catch (e) {
      setStatus(parseErr(e), "err");
    } finally {
      setBusy(false);
    }
  }

  return { run, busy, msg, kind, setStatus };
}
