"use client";

import { useEffect, useState } from "react";
import { useAccount, useBalance, useReadContract, useWriteContract } from "wagmi";
import { formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { activeChain } from "@/lib/chains";
import { FLOOR, floorReady, basketRouterAbi, erc20MiniAbi } from "@/lib/floor";
import { useTx } from "@/lib/useTx";
import { client, waitForSuccessfulReceipt } from "@/lib/client";
import { Icon } from "@/components/ui/Icon";
import { StatusLine } from "@/components/ui/Status";

const DEADLINE_S = 600n;
const deadline = () => BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_S;

function parse18(v: string): bigint | undefined {
  try {
    return v && Number(v) > 0 ? parseUnits(v, 18) : undefined;
  } catch {
    return undefined;
  }
}

const fmtOut = (wei: bigint, dp = 5) =>
  Number(formatUnits(wei, 18)).toLocaleString("en-US", { maximumFractionDigits: dp });

// Classic swap layout: a "you pay" panel, a flip arrow, a "you receive" panel, one big
// button. Quotes come from an eth_call simulation of the actual trade whenever the wallet
// can run it, so the number shown is the number the contract would deliver right now.
export function Terminal() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const swapTx = useTx();
  const basketTx = useTx();

  const [dir, setDir] = useState<"buy" | "sell">("buy");
  const [stockIdx, setStockIdx] = useState(0);
  const [sellOutEth, setSellOutEth] = useState(true);
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<{ text: string; approx: boolean } | null>(null);

  const [basketDir, setBasketDir] = useState<"buy" | "sell">("buy");
  const [basketAmount, setBasketAmount] = useState("");
  const [basketOutEth, setBasketOutEth] = useState(true);

  const stock = FLOOR.stocks[stockIdx];
  const router = FLOOR.router as `0x${string}`;
  const offline = !floorReady;

  const { data: ethBal } = useBalance({ address, chainId: activeChain.id });
  const { data: feeBps } = useReadContract({
    address: floorReady ? router : undefined,
    abi: basketRouterAbi,
    functionName: "feeBps",
    query: { enabled: floorReady },
  });
  const { data: livePreset } = useReadContract({
    address: floorReady ? router : undefined,
    abi: basketRouterAbi,
    functionName: "preset",
    args: [0n],
    query: { enabled: floorReady },
  });
  const { data: stockBal, refetch: refetchStockBal } = useReadContract({
    address: stock?.address,
    abi: erc20MiniAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!stock },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: stock?.address,
    abi: erc20MiniAbi,
    functionName: "allowance",
    args: address && floorReady ? [address, router] : undefined,
    query: { enabled: !!address && floorReady && !!stock },
  });

  const amountWei = parse18(amount);
  const feePct = feeBps !== undefined ? Number(feeBps) / 100 : 0.3;
  const presetName = livePreset ? livePreset[2] : FLOOR.presets[0].name;
  const presetLegs = livePreset ? livePreset[0].length : 0;

  // live quote — debounced simulation of the real call
  useEffect(() => {
    if (offline || !stock || amountWei === undefined) {
      setQuote(null);
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      try {
        if (dir === "buy") {
          if (!address || !ethBal || ethBal.value < amountWei) {
            setQuote({ text: "connect a funded wallet to quote", approx: true });
            return;
          }
          const { result } = await client.simulateContract({
            address: router,
            abi: basketRouterAbi,
            functionName: "buyStockEth",
            args: [stock.address, 0n, address, deadline()],
            value: amountWei,
            account: address,
          });
          if (!stale) setQuote({ text: `${fmtOut(result)} ${stock.symbol}`, approx: false });
        } else {
          // guard floor read works without approvals; re-inflate the slippage haircut
          const floor = (await client.readContract({
            address: router,
            abi: basketRouterAbi,
            functionName: "minUsdgOut",
            args: [stock.address, amountWei],
          })) as bigint;
          const est = (floor * 10000n) / 9500n;
          const net = (est * (10000n - BigInt(feeBps ?? 30n))) / 10000n;
          if (!stale)
            setQuote({
              text: sellOutEth ? `≈ $${fmtOut(net, 2)} in ETH` : `≈ ${fmtOut(net, 2)} USDG`,
              approx: true,
            });
        }
      } catch {
        if (!stale) setQuote({ text: "no quote — check amount", approx: true });
      }
    }, 400);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [dir, amount, stockIdx, sellOutEth, address, offline]); // eslint-disable-line react-hooks/exhaustive-deps

  const needsApproval =
    dir === "sell" &&
    amountWei !== undefined &&
    allowance !== undefined &&
    (allowance as bigint) < amountWei;

  async function doSwap() {
    if (!stock || amountWei === undefined) return;
    await swapTx.run(async () => {
      if (dir === "buy") {
        swapTx.setStatus("Confirm in your wallet…");
        const hash = await writeContractAsync({
          address: router,
          abi: basketRouterAbi,
          functionName: "buyStockEth",
          args: [stock.address, 0n, address!, deadline()],
          value: amountWei,
        });
        swapTx.setStatus("Executing…");
        await waitForSuccessfulReceipt(hash);
        swapTx.setStatus(`Bought ${stock.symbol} — it is in your wallet.`, "ok");
      } else {
        if (needsApproval) {
          swapTx.setStatus(`Approve ${stock.symbol} first…`);
          const a = await writeContractAsync({
            address: stock.address,
            abi: erc20MiniAbi,
            functionName: "approve",
            args: [router, amountWei],
          });
          await waitForSuccessfulReceipt(a);
          await refetchAllowance();
        }
        swapTx.setStatus("Confirm the sale…");
        const hash = await writeContractAsync({
          address: router,
          abi: basketRouterAbi,
          functionName: "sellStock",
          args: [stock.address, amountWei, sellOutEth, 0n, address!, deadline()],
        });
        swapTx.setStatus("Executing…");
        await waitForSuccessfulReceipt(hash);
        swapTx.setStatus(`Sold — ${sellOutEth ? "ETH" : "USDG"} is in your wallet.`, "ok");
      }
      setAmount("");
      refetchStockBal();
    });
  }

  async function doBasket() {
    await basketTx.run(async () => {
      if (basketDir === "buy") {
        const wei = parse18(basketAmount);
        if (wei === undefined) return;
        basketTx.setStatus("Confirm in your wallet…");
        const hash = await writeContractAsync({
          address: router,
          abi: basketRouterAbi,
          functionName: "buyBasketEth",
          args: [0n, address!, deadline()],
          value: wei,
        });
        basketTx.setStatus("Buying every stock in one transaction…");
        await waitForSuccessfulReceipt(hash);
        basketTx.setStatus("Basket delivered.", "ok");
        setBasketAmount("");
      } else {
        if (!livePreset) return;
        const tokens = [...livePreset[0]];
        // approve any leg that needs it, then exit everything in ONE transaction
        for (const t of tokens) {
          const bal = (await client.readContract({
            address: t,
            abi: erc20MiniAbi,
            functionName: "balanceOf",
            args: [address!],
          })) as bigint;
          if (bal === 0n) continue;
          const cur = (await client.readContract({
            address: t,
            abi: erc20MiniAbi,
            functionName: "allowance",
            args: [address!, router],
          })) as bigint;
          if (cur < bal) {
            basketTx.setStatus("Approving basket stocks…");
            const a = await writeContractAsync({
              address: t,
              abi: erc20MiniAbi,
              functionName: "approve",
              args: [router, bal],
            });
            await waitForSuccessfulReceipt(a);
          }
        }
        basketTx.setStatus("Confirm the basket exit…");
        const hash = await writeContractAsync({
          address: router,
          abi: basketRouterAbi,
          functionName: "sellBasket",
          args: [tokens, tokens.map(() => 0n), basketOutEth, 0n, address!, deadline()],
        });
        basketTx.setStatus("Selling everything in one transaction…");
        await waitForSuccessfulReceipt(hash);
        basketTx.setStatus(`Basket sold — ${basketOutEth ? "ETH" : "USDG"} is in your wallet.`, "ok");
      }
      refetchStockBal();
    });
  }

  const payLabel =
    dir === "buy"
      ? address && ethBal
        ? `Balance: ${Number(formatEther(ethBal.value)).toFixed(4)}`
        : ""
      : address && stockBal !== undefined
        ? `Balance: ${fmtOut(stockBal as bigint, 4)}`
        : "";

  return (
    <div className="space-y-6">
      {offline && (
        <div className="border-l-[3px] border-accent bg-cream-2 px-4 py-3 text-sm">
          The trading venue is not wired on this network yet — preview only.
        </div>
      )}

      {/* classic swap widget */}
      <section className="card max-w-xl">
        <h2 className="pixel-title text-[15px] mb-3">Swap</h2>

        <div className="bg-cream-2 border-2 border-ink p-3">
          <div className="flex items-center justify-between">
            <span className="label">You pay</span>
            <span className="label">{payLabel}</span>
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <input
              className="w-full font-sans text-2xl text-ink-strong bg-transparent outline-none min-w-0"
              placeholder="0.0"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={offline}
            />
            {dir === "buy" ? (
              <span className="font-pixel text-xs border-2 border-ink px-3 py-2 shrink-0">ETH</span>
            ) : (
              <select
                className="font-pixel text-xs border-2 border-ink bg-cream px-2 py-2 shrink-0"
                value={stockIdx}
                onChange={(e) => setStockIdx(Number(e.target.value))}
                disabled={offline}
              >
                {FLOOR.stocks.map((s, i) => (
                  <option key={s.address} value={i}>
                    {s.symbol}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div className="flex justify-center -my-2.5 relative z-10">
          <button
            aria-label="flip direction"
            className="border-2 border-ink bg-cream px-2.5 py-1 hover:shadow-pixel-sm"
            onClick={() => {
              setDir(dir === "buy" ? "sell" : "buy");
              setAmount("");
              setQuote(null);
            }}
            disabled={offline}
          >
            <Icon name="swap" className="w-4 h-4 rotate-90" />
          </button>
        </div>

        <div className="bg-cream-2 border-2 border-ink p-3">
          <span className="label">You receive</span>
          <div className="flex items-center gap-2 mt-1.5">
            <div className="w-full font-sans text-2xl text-ink-strong truncate min-w-0">
              {quote ? quote.text : "—"}
            </div>
            {dir === "buy" ? (
              <select
                className="font-pixel text-xs border-2 border-ink bg-cream px-2 py-2 shrink-0"
                value={stockIdx}
                onChange={(e) => setStockIdx(Number(e.target.value))}
                disabled={offline}
              >
                {FLOOR.stocks.map((s, i) => (
                  <option key={s.address} value={i}>
                    {s.symbol}
                  </option>
                ))}
              </select>
            ) : (
              <select
                className="font-pixel text-xs border-2 border-ink bg-cream px-2 py-2 shrink-0"
                value={sellOutEth ? "eth" : "usdg"}
                onChange={(e) => setSellOutEth(e.target.value === "eth")}
                disabled={offline}
              >
                <option value="eth">ETH</option>
                <option value="usdg">USDG</option>
              </select>
            )}
          </div>
        </div>

        <p className="label mt-3">
          Fee {feePct}% — funds Broker payroll · priced against Chainlink with an on-chain floor
        </p>
        <button
          className="btn btn-accent w-full mt-3"
          onClick={doSwap}
          disabled={offline || swapTx.busy || amountWei === undefined}
        >
          {dir === "sell" && needsApproval ? "Approve + swap" : "Swap"}
        </button>
        <StatusLine msg={swapTx.msg} kind={swapTx.kind} />
      </section>

      {/* basket widget — same shape, whole basket at once */}
      <section className="card max-w-xl">
        <div className="flex items-center justify-between mb-3">
          <h2 className="pixel-title text-[15px]">Basket</h2>
          <div className="flex border-2 border-ink">
            {(["buy", "sell"] as const).map((d) => (
              <button
                key={d}
                className={`font-pixel text-xs px-3 py-1.5 ${
                  basketDir === d ? "bg-ink text-cream" : "text-ink-soft hover:text-ink-strong"
                }`}
                onClick={() => setBasketDir(d)}
              >
                {d === "buy" ? "Buy" : "Sell all"}
              </button>
            ))}
          </div>
        </div>

        {basketDir === "buy" ? (
          <>
            <div className="bg-cream-2 border-2 border-ink p-3">
              <span className="label">You pay</span>
              <div className="flex items-center gap-2 mt-1.5">
                <input
                  className="w-full font-sans text-2xl text-ink-strong bg-transparent outline-none min-w-0"
                  placeholder="0.0"
                  inputMode="decimal"
                  value={basketAmount}
                  onChange={(e) => setBasketAmount(e.target.value)}
                  disabled={offline}
                />
                <span className="font-pixel text-xs border-2 border-ink px-3 py-2 shrink-0">ETH</span>
              </div>
            </div>
            <div className="bg-cream-2 border-2 border-ink p-3 mt-2">
              <span className="label">You receive — one transaction</span>
              <div className="font-sans text-lg text-ink-strong mt-1">
                {presetName}
                {presetLegs > 0 ? ` · ${presetLegs} stock${presetLegs > 1 ? "s" : ""}` : ""}
              </div>
              <p className="text-sm text-ink-soft mt-0.5">{FLOOR.presets[0].blurb}</p>
            </div>
          </>
        ) : (
          <>
            <div className="bg-cream-2 border-2 border-ink p-3">
              <span className="label">You sell — one transaction</span>
              <div className="font-sans text-lg text-ink-strong mt-1">
                Your entire {presetName} position
              </div>
              <p className="text-sm text-ink-soft mt-0.5">
                Every basket stock you hold, swept in a single trade.
              </p>
            </div>
            <div className="bg-cream-2 border-2 border-ink p-3 mt-2">
              <div className="flex items-center justify-between">
                <span className="label">You receive</span>
                <select
                  className="font-pixel text-xs border-2 border-ink bg-cream px-2 py-2"
                  value={basketOutEth ? "eth" : "usdg"}
                  onChange={(e) => setBasketOutEth(e.target.value === "eth")}
                  disabled={offline}
                >
                  <option value="eth">ETH</option>
                  <option value="usdg">USDG</option>
                </select>
              </div>
            </div>
          </>
        )}

        <button
          className="btn btn-accent w-full mt-3"
          onClick={doBasket}
          disabled={
            offline || basketTx.busy || (basketDir === "buy" ? !parse18(basketAmount) : !address)
          }
        >
          {basketDir === "buy" ? "Buy basket" : "Sell entire basket"}
        </button>
        <StatusLine msg={basketTx.msg} kind={basketTx.kind} />
      </section>

      <p className="text-sm text-ink-soft max-w-xl">
        Non-custodial: everything settles into your wallet in the same transaction. The {feePct}%
        fee streams to the machine that pays 1,776 Broker salaries.
      </p>
    </div>
  );
}
