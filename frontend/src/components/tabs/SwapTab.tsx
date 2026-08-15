"use client";

import { useState } from "react";
import { useAccount, useBalance, useReadContract, useWriteContract } from "wagmi";
import { formatUnits, parseEther, parseUnits } from "viem";
import { ADDR } from "@/lib/config";
import { coatAbi, routerAbi } from "@/lib/abis";
import { activeChain } from "@/lib/chains";
import { useTx } from "@/lib/useTx";
import { client, waitForSuccessfulReceipt } from "@/lib/client";
import { fmt } from "@/lib/format";
import { Icon } from "@/components/ui/Icon";
import { StatusLine } from "@/components/ui/Status";
import { StepFlow, type StepState } from "@/components/ui/StepFlow";

const SLIPPAGE_BPS = 300n; // 3%
const routerReady = ADDR.router !== "";

export function SwapTab() {
  const { address } = useAccount();
  
  const { writeContractAsync } = useWriteContract();
  const swap = useTx();
  const approval = useTx();

  const [dir, setDir] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState("");
  const [steps, setSteps] = useState<StepState[]>(["idle", "idle"]);
  const setStep = (i: number, s: StepState) => setSteps((p) => p.map((v, j) => (j === i ? s : v)));

  const { data: eth } = useBalance({ address, chainId: activeChain.id });
  const { data: coat } = useReadContract({
    address: ADDR.coat, abi: coatAbi, functionName: "balanceOf",
    args: address ? [address] : undefined, query: { enabled: !!address },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: ADDR.coat,
    abi: coatAbi,
    functionName: "allowance",
    args: address && routerReady ? [address, ADDR.router as `0x${string}`] : undefined,
    query: { enabled: !!address && routerReady && dir === "sell" },
  });

  // pre-flight balance check so a doomed swap never reaches the wallet
  let amountWei: bigint | undefined;
  try {
    amountWei = amount && Number(amount) > 0 ? (dir === "buy" ? parseEther(amount) : parseUnits(amount, 18)) : undefined;
  } catch {
    amountWei = undefined;
  }
  const balance = dir === "buy" ? eth?.value : (coat as bigint | undefined);
  const insufficient = !!(address && amountWei !== undefined && balance !== undefined && balance < amountWei);
  const reason = !routerReady
    ? ""
    : !address
      ? "Connect your wallet to swap."
      : insufficient
        ? `Not enough ${dir === "buy" ? "ETH" : "$COAT"}.`
        : "";
  const canSwap = routerReady && !!address && amountWei !== undefined && !insufficient;
  const needsApproval = dir === "sell" && amountWei !== undefined && (allowance as bigint | undefined ?? 0n) < amountWei;
  const rawSellAmount = amountWei !== undefined && dir === "sell" ? formatUnits(amountWei, 18) : "";

  async function onAmount(v: string) {
    setAmount(v);
    setQuote("");
    if (!routerReady || !v || isNaN(Number(v)) || Number(v) <= 0) return;
    try {
      const out =
        dir === "buy"
          ? await client.readContract({ address: ADDR.router as `0x${string}`, abi: routerAbi, functionName: "quoteBuy", args: [parseEther(v)] })
          : await client.readContract({ address: ADDR.router as `0x${string}`, abi: routerAbi, functionName: "quoteSell", args: [parseUnits(v, 18)] });
      setQuote(fmt(out as bigint, 18, dir === "buy" ? 2 : 6));
    } catch {
      setQuote("—");
    }
  }

  function chooseDirection(next: "buy" | "sell") {
    setDir(next);
    setAmount("");
    setQuote("");
    setSteps(["idle", "idle"]);
  }

  function useMaxCoat() {
    const balance = coat as bigint | undefined;
    if (balance !== undefined && balance > 0n) void onAmount(formatUnits(balance, 18));
  }

  const doSwap = () =>
    swap.run(async () => {
      if (!routerReady) throw new Error("Swap router not wired in this build.");
      if (!amount || Number(amount) <= 0) throw new Error("Enter an amount.");
      const router = ADDR.router as `0x${string}`;
      if (dir === "buy") {
        // Quote by SIMULATING the real swap (minOut=0) — the router's spot-price quoteBuy
        // over-estimates on a single-sided pool, which would make minOut too high and revert.
        const value = parseEther(amount);
        const sim = await client.simulateContract({
          account: address!, address: router, abi: routerAbi, functionName: "buy", args: [0n, address!], value,
        });
        const expected = sim.result as bigint;
        const min = expected - (expected * SLIPPAGE_BPS) / 10_000n;
        setStep(0, "done");
        setStep(1, "doing");
        swap.setStatus(`Confirm: buy ≈ ${fmt(expected, 18, 0)} COAT (≥ ${fmt(min, 18, 0)}) for ${amount} ETH…`);
        const h = await writeContractAsync({ address: router, abi: routerAbi, functionName: "buy", args: [min, address!], value, chainId: activeChain.id });
        await waitForSuccessfulReceipt(h);
      } else {
        const coatIn = parseUnits(amount, 18);
        const currentAllowance = (await client.readContract({ address: ADDR.coat, abi: coatAbi, functionName: "allowance", args: [address!, router] })) as bigint;
        if (currentAllowance < coatIn) throw new Error("Approve $COAT first. Approval never performs a swap.");
        setStep(0, "done");
        setStep(1, "doing");
        // simulate the real sell (needs the allowance above) for an accurate minimum-out
        const sim = await client.simulateContract({
          account: address!, address: router, abi: routerAbi, functionName: "sell", args: [coatIn, 0n, address!],
        });
        const expected = sim.result as bigint;
        const min = expected - (expected * SLIPPAGE_BPS) / 10_000n;
        swap.setStatus(`Confirm: sell ${amount} COAT for ≈ ${fmt(expected, 18, 6)} ETH (≥ ${fmt(min, 18, 6)})…`);
        const h = await writeContractAsync({ address: router, abi: routerAbi, functionName: "sell", args: [coatIn, min, address!], chainId: activeChain.id });
        await waitForSuccessfulReceipt(h);
      }
      setStep(1, "done");
      swap.setStatus("Swap complete.", "ok");
    });

  const approveSell = () =>
    approval.run(async () => {
      if (!address || amountWei === undefined || dir !== "sell") throw new Error("Enter a $COAT amount first.");
      const router = ADDR.router as `0x${string}`;
      approval.setStatus(`Confirm approval for ${amount} $COAT. This transaction cannot swap or spend COAT.`);
      const hash = await writeContractAsync({
        address: ADDR.coat, abi: coatAbi, functionName: "approve", args: [router, amountWei], chainId: activeChain.id,
      });
      await waitForSuccessfulReceipt(hash);
      await refetchAllowance();
      setStep(0, "done");
      approval.setStatus("Approval complete. Press SELL COAT to submit the separate swap.", "ok");
    });

  return (
    <div className="card max-w-xl">
      <h2 className="pixel-title text-[15px] mb-1">Swap $COAT</h2>
      <p className="text-ink-soft text-sm mb-5">
        Buy $COAT with ETH or sell back on the live Uniswap v4 pool. Buying never needs approval;
        selling requires a separate approval followed by a separate sell confirmation.
      </p>

      <div className="grid grid-cols-3 gap-2.5 mb-4">
        <Stat k="Your ETH" v={eth ? fmt(eth.value, 18, 4) : "—"} />
        <Stat k="Your $COAT" v={fmt(coat as bigint | undefined, 18, 0)} />
        <Stat k="Fee / swap" v="1% + 1% hook" />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4" aria-label="Swap direction">
        <button className={`btn ${dir === "buy" ? "btn-accent" : "btn-ghost"}`} onClick={() => chooseDirection("buy")}>BUY · ETH → COAT</button>
        <button className={`btn ${dir === "sell" ? "btn-accent" : "btn-ghost"}`} onClick={() => chooseDirection("sell")}>SELL · COAT → ETH</button>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="label">You pay ({dir === "buy" ? "ETH" : "COAT"})</span>
        {dir === "sell" && (
          <button className="text-[11px] font-pixel text-accent hover:text-ink-strong" onClick={useMaxCoat} disabled={!coat}>
            MAX COAT
          </button>
        )}
      </div>
      <div className="relative">
        <input className="fld" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => onAmount(e.target.value)} disabled={!routerReady} />
      </div>
      {dir === "sell" && rawSellAmount && (
        <p className="text-ink-soft text-sm mt-2">
          Order amount: <b className="text-ink-strong tabular-nums">{rawSellAmount} COAT</b>. Use MAX to sell the full balance; dots in this field are decimal points, not thousands separators.
        </p>
      )}
      <span className="label mt-3.5">You receive ({dir === "buy" ? "COAT" : "ETH"}, est.)</span>
      <input className="fld" readOnly value={quote} placeholder="—" />
      <p className="text-ink-soft text-sm mt-2">Slippage 3% · minimum shown on confirm.</p>

      <button className="btn btn-accent w-full mt-4" onClick={needsApproval ? approveSell : doSwap} disabled={!canSwap || swap.busy || approval.busy}>
        <Icon name="swap" /> {approval.busy ? "APPROVING…" : swap.busy ? "SWAPPING…" : dir === "buy" ? "BUY COAT" : needsApproval ? `APPROVE ${rawSellAmount} COAT` : `SELL ${rawSellAmount} COAT`}
      </button>
      {reason && <p className="text-accent text-sm mt-2">{reason}</p>}
      <StepFlow steps={[{ label: dir === "buy" ? "quote" : "approve COAT", state: steps[0] }, { label: dir === "buy" ? "buy" : "sell", state: steps[1] }]} />
      <StatusLine msg={swap.msg} kind={swap.kind} />
      <StatusLine msg={approval.msg} kind={approval.kind} />

      {!routerReady && (
        <div className="border-l-[3px] border-accent bg-cream-2 px-4 py-3 mt-4 text-sm">
          Swap router not yet wired for this build. Buy $COAT directly on the v4 pool (id in{" "}
          <b>Docs</b>) or a RH-Chain DEX UI, then use <b>Activate</b>.
        </div>
      )}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="text-[11px] text-ink-soft uppercase tracking-widest">{k}</div>
      <div className="font-pixel text-lg text-ink-strong mt-1">{v}</div>
    </div>
  );
}
