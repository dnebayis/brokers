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
import { useCoatPrice, usdLabel } from "@/lib/useCoatPrice";
import { hasAllowance, waitForAllowance } from "@/lib/allowance";

const SLIPPAGE_BPS = 300n; // 3%
const routerReady = ADDR.router !== "";

export function CoatSwap() {
  const { address } = useAccount();
  
  const { writeContractAsync } = useWriteContract();
  const swap = useTx();

  const [dir, setDir] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState("");
  const [quoteWei, setQuoteWei] = useState<bigint | undefined>(undefined);
  const [steps, setSteps] = useState<StepState[]>(["idle", "idle"]);
  // /trade is server-rendered: hide the stored price on the first client paint or the
  // hydrated text never matches the server's "—".
  const price = useCoatPrice({ ssrSafe: true });
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
    setQuoteWei(undefined);
    if (!routerReady || !v || isNaN(Number(v)) || Number(v) <= 0) return;
    try {
      const out =
        dir === "buy"
          ? await client.readContract({ address: ADDR.router as `0x${string}`, abi: routerAbi, functionName: "quoteBuy", args: [parseEther(v)] })
          : await client.readContract({ address: ADDR.router as `0x${string}`, abi: routerAbi, functionName: "quoteSell", args: [parseUnits(v, 18)] });
      setQuote(fmt(out as bigint, 18, dir === "buy" ? 2 : 6));
      setQuoteWei(out as bigint);
    } catch {
      setQuote("—");
      setQuoteWei(undefined);
    }
  }

  function chooseDirection(next: "buy" | "sell") {
    setDir(next);
    setAmount("");
    setQuote("");
    setQuoteWei(undefined);
    setSteps(["idle", "idle"]);
  }

  function useMaxCoat() {
    const balance = coat as bigint | undefined;
    if (balance !== undefined && balance > 0n) void onAmount(formatUnits(balance, 18));
  }

  // One button, one flow. Selling takes two signatures (approve, then sell) and the second
  // follows the first without a second click, the way every swap UI behaves. Every read
  // that gates on the approval tolerates the public RPC lagging a block: right after the
  // approval is mined a lagging node still returns the old allowance, which used to make
  // this component ask for the same approval again and refuse to sell.
  const doSwap = () =>
    swap.run(async () => {
      if (!routerReady) throw new Error("Swap router not wired in this build.");
      if (!amount || Number(amount) <= 0) throw new Error("Enter an amount.");
      const router = ADDR.router as `0x${string}`;
      if (dir === "buy") {
        // Quote by SIMULATING the real swap (minOut=0) — the router's spot-price quoteBuy
        // over-estimates on a single-sided pool, which would make minOut too high and revert.
        const value = parseEther(amount);
        setStep(0, "doing");
        const sim = await client.simulateContract({
          account: address!, address: router, abi: routerAbi, functionName: "buy", args: [0n, address!], value,
        });
        const expected = sim.result as bigint;
        const min = expected - (expected * SLIPPAGE_BPS) / 10_000n;
        setStep(0, "done");
        setStep(1, "doing");
        swap.setStatus(`Confirm in your wallet: buy ≈ ${fmt(expected, 18, 0)} COAT (at least ${fmt(min, 18, 0)}) for ${amount} ETH.`);
        const h = await writeContractAsync({ address: router, abi: routerAbi, functionName: "buy", args: [min, address!], value, chainId: activeChain.id });
        swap.setStatus("Buying…");
        await waitForSuccessfulReceipt(h);
      } else {
        const coatIn = parseUnits(amount, 18);
        setStep(0, "doing");
        if (!(await hasAllowance(ADDR.coat, address!, router, coatIn))) {
          swap.setStatus(`Signature 1 of 2: approve ${amount} $COAT for the router. This step cannot swap or spend COAT.`);
          const a = await writeContractAsync({
            address: ADDR.coat, abi: coatAbi, functionName: "approve", args: [router, coatIn], chainId: activeChain.id,
          });
          swap.setStatus("Approval sent, waiting for it to be mined…");
          await waitForSuccessfulReceipt(a);
          // The receipt is final; a node that still answers with the old allowance is behind,
          // not right. Wait for one that has caught up before simulating the sell.
          if (!(await waitForAllowance(ADDR.coat, address!, router, coatIn))) {
            throw new Error("The approval is mined but the network has not caught up yet. Press SELL again in a few seconds; no second approval is needed.");
          }
          await refetchAllowance();
        }
        setStep(0, "done");
        setStep(1, "doing");
        // simulate the real sell (needs the allowance above) for an accurate minimum-out
        const sim = await client.simulateContract({
          account: address!, address: router, abi: routerAbi, functionName: "sell", args: [coatIn, 0n, address!],
        });
        const expected = sim.result as bigint;
        const min = expected - (expected * SLIPPAGE_BPS) / 10_000n;
        swap.setStatus(`Signature 2 of 2: sell ${amount} COAT for ≈ ${fmt(expected, 18, 6)} ETH (at least ${fmt(min, 18, 6)}).`);
        const h = await writeContractAsync({ address: router, abi: routerAbi, functionName: "sell", args: [coatIn, min, address!], chainId: activeChain.id });
        swap.setStatus("Selling…");
        await waitForSuccessfulReceipt(h);
        await refetchAllowance();
      }
      setStep(1, "done");
      swap.setStatus("Swap complete.", "ok");
      setAmount("");
      setQuote("");
      setQuoteWei(undefined);
    });

  // Button copy is the state machine: every state a swap can be in has one label.
  const buttonLabel = !address
    ? "CONNECT WALLET"
    : amountWei === undefined
      ? "ENTER AN AMOUNT"
      : insufficient
        ? `NOT ENOUGH ${dir === "buy" ? "ETH" : "COAT"}`
        : swap.busy
          ? (steps[0] === "doing" ? (dir === "buy" ? "QUOTING…" : "APPROVING…") : dir === "buy" ? "BUYING…" : "SELLING…")
          : dir === "buy"
            ? "BUY COAT"
            : needsApproval
              ? `APPROVE & SELL ${rawSellAmount} COAT`
              : `SELL ${rawSellAmount} COAT`;

  return (
    <div className="card">
      <h2 className="pixel-title text-[15px] mb-1">Swap $COAT</h2>
      <p className="text-ink-soft text-sm mb-5">
        Buy $COAT with ETH or sell it back, straight against the hooked v4 pool that holds the
        real liquidity. Buying is one signature; selling is an exact approval followed by the sell, in one go.
      </p>

      <div className="grid grid-cols-3 gap-2.5 mb-4">
        <Stat k="Your ETH" v={eth ? fmt(eth.value, 18, 4) : "—"} sub={usdLabel(price.ethWeiToUsd(eth?.value))} />
        <Stat k="Your $COAT" v={fmt(coat as bigint | undefined, 18, 0)} sub={usdLabel(price.coatWeiToUsd(coat as bigint | undefined))} />
        <Stat k="$COAT price" v={usdLabel(price.coatUsd || undefined)} sub={price.ready ? `ETH ${usdLabel(price.ethUsd)}` : "loading"} />
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
      <p className="text-ink-soft text-[12px] mt-1.5 tabular-nums" aria-live="polite">
        ≈ {usdLabel(dir === "buy" ? price.ethWeiToUsd(amountWei) : price.coatWeiToUsd(amountWei))}
      </p>
      {dir === "sell" && rawSellAmount && (
        <p className="text-ink-soft text-sm mt-2">
          Order amount: <b className="text-ink-strong tabular-nums">{rawSellAmount} COAT</b>. Use MAX to sell the full balance; dots in this field are decimal points, not thousands separators.
        </p>
      )}
      <span className="label mt-3.5">You receive ({dir === "buy" ? "COAT" : "ETH"}, est.)</span>
      <input className="fld" readOnly value={quote} placeholder="—" />
      <p className="text-ink-soft text-[12px] mt-1.5 tabular-nums" aria-live="polite">
        ≈ {usdLabel(dir === "buy" ? price.coatWeiToUsd(quoteWei) : price.ethWeiToUsd(quoteWei))}
      </p>
      <p className="text-ink-soft text-sm mt-2">Slippage 3% · minimum shown on confirm.</p>

      <button className="btn btn-accent w-full mt-4" onClick={doSwap} disabled={!canSwap || swap.busy}>
        <Icon name="swap" /> {buttonLabel}
      </button>
      {reason && <p className="text-accent text-sm mt-2">{reason}</p>}
      {dir === "sell" && needsApproval && amountWei !== undefined && !insufficient && (
        <p className="text-ink-soft text-[12px] mt-2">Two signatures: an exact approval for this amount, then the sell. Nothing else is approved.</p>
      )}
      <StepFlow steps={[{ label: dir === "buy" ? "quote" : "approve COAT", state: steps[0] }, { label: dir === "buy" ? "buy" : "sell", state: steps[1] }]} />
      <StatusLine msg={swap.msg} kind={swap.kind} />

      {!routerReady && (
        <div className="border-l-[3px] border-accent bg-cream-2 px-4 py-3 mt-4 text-sm">
          Swap router not yet wired for this build. Buy $COAT directly on the v4 pool (id in{" "}
          <b>Docs</b>) or a RH-Chain DEX UI, then use <b>Activate</b>.
        </div>
      )}
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="text-[11px] text-ink-soft uppercase tracking-widest">{k}</div>
      <div className="font-pixel text-lg text-ink-strong mt-1 break-words">{v}</div>
      {sub && <div className="text-[11px] text-ink-soft mt-0.5 tabular-nums">{sub}</div>}
    </div>
  );
}
