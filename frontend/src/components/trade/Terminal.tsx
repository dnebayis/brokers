"use client";

import { useState } from "react";
import { useAccount, useBalance, useReadContract, useWriteContract } from "wagmi";
import { formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { activeChain } from "@/lib/chains";
import { FLOOR, floorReady, basketRouterAbi, erc20MiniAbi } from "@/lib/floor";
import { useTx } from "@/lib/useTx";
import { waitForSuccessfulReceipt } from "@/lib/client";
import { StatusLine } from "@/components/ui/Status";

const DEADLINE_S = 600n;

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_S;
}

export function Terminal() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const buyTx = useTx();
  const basketTx = useTx();
  const sellTx = useTx();

  const [stockIdx, setStockIdx] = useState(0);
  const [ethIn, setEthIn] = useState("");
  const [basketEthIn, setBasketEthIn] = useState("");
  const [sellAmount, setSellAmount] = useState("");
  const [sellToEth, setSellToEth] = useState(true);

  const stock = FLOOR.stocks[stockIdx];
  const router = FLOOR.router as `0x${string}`;

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
  const { data: stockBal } = useReadContract({
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

  let ethWei: bigint | undefined;
  try {
    ethWei = ethIn && Number(ethIn) > 0 ? parseEther(ethIn) : undefined;
  } catch {
    ethWei = undefined;
  }
  let sellWei: bigint | undefined;
  try {
    sellWei = sellAmount && Number(sellAmount) > 0 ? parseUnits(sellAmount, 18) : undefined;
  } catch {
    sellWei = undefined;
  }

  const needsApproval =
    sellWei !== undefined && allowance !== undefined && (allowance as bigint) < sellWei;

  const feePct = feeBps !== undefined ? Number(feeBps) / 100 : 0.3;
  const presetName = livePreset ? livePreset[2] : FLOOR.presets[0].name;
  const presetLegs = livePreset ? livePreset[0].length : 0;
  const offline = !floorReady;

  async function buy() {
    if (!stock || ethWei === undefined) return;
    await buyTx.run(async () => {
      buyTx.setStatus("Confirm in your wallet…");
      const hash = await writeContractAsync({
        address: router,
        abi: basketRouterAbi,
        functionName: "buyStockEth",
        args: [stock.address, 0n, address!, deadline()],
        value: ethWei!,
      });
      buyTx.setStatus("Executing…");
      await waitForSuccessfulReceipt(hash);
      buyTx.setStatus(`Bought ${stock.symbol}. It is in your wallet.`, "ok");
      setEthIn("");
    });
  }

  async function buyBasket() {
    let wei: bigint | undefined;
    try {
      wei = basketEthIn && Number(basketEthIn) > 0 ? parseEther(basketEthIn) : undefined;
    } catch {
      wei = undefined;
    }
    if (wei === undefined) return;
    await basketTx.run(async () => {
      basketTx.setStatus("Confirm in your wallet…");
      const hash = await writeContractAsync({
        address: router,
        abi: basketRouterAbi,
        functionName: "buyBasketEth",
        args: [0n, address!, deadline()],
        value: wei!,
      });
      basketTx.setStatus("Buying the whole basket…");
      await waitForSuccessfulReceipt(hash);
      basketTx.setStatus("Basket delivered — every stock is in your wallet.", "ok");
      setBasketEthIn("");
    });
  }

  async function sell() {
    if (!stock || sellWei === undefined) return;
    await sellTx.run(async () => {
      if (needsApproval) {
        sellTx.setStatus(`Approve ${stock.symbol} first…`);
        const a = await writeContractAsync({
          address: stock.address,
          abi: erc20MiniAbi,
          functionName: "approve",
          args: [router, sellWei!],
        });
        await waitForSuccessfulReceipt(a);
        await refetchAllowance();
      }
      sellTx.setStatus("Confirm the sale…");
      const hash = await writeContractAsync({
        address: router,
        abi: basketRouterAbi,
        functionName: "sellStock",
        args: [stock.address, sellWei!, sellToEth, 0n, address!, deadline()],
      });
      sellTx.setStatus("Executing…");
      await waitForSuccessfulReceipt(hash);
      sellTx.setStatus(`Sold. ${sellToEth ? "ETH" : "USDG"} is in your wallet.`, "ok");
      setSellAmount("");
    });
  }

  return (
    <div className="space-y-6">
      {offline && (
        <div className="border-l-[3px] border-accent bg-cream-2 px-4 py-3 text-sm">
          The trading venue is not wired on this network yet — this is a preview and the
          buttons are disabled.
        </div>
      )}

      {/* one-transaction basket — the headline product, so it comes first */}
      <section className="card">
        <div className="flex items-center justify-between gap-3">
          <h2 className="pixel-title text-[15px] mb-1">Buy the basket, one transaction</h2>
          <span className="label">
            {presetName}
            {presetLegs > 0 ? ` · ${presetLegs} stock${presetLegs > 1 ? "s" : ""}` : ""}
          </span>
        </div>
        <p className="text-sm text-ink-soft">{FLOOR.presets[0].blurb}</p>
        <div className="grid grid-cols-2 gap-2 mt-3">
          <input
            className="fld"
            placeholder="ETH amount"
            inputMode="decimal"
            value={basketEthIn}
            onChange={(e) => setBasketEthIn(e.target.value)}
            disabled={offline}
          />
          <button
            className="btn btn-accent"
            onClick={buyBasket}
            disabled={offline || basketTx.busy || !basketEthIn}
          >
            Buy basket
          </button>
        </div>
        <StatusLine msg={basketTx.msg} kind={basketTx.kind} />
      </section>

      {/* single-stock swap */}
      <section className="card">
        <h2 className="pixel-title text-[15px] mb-1">Single stock</h2>
        <div className="label mt-3.5">Buy with ETH</div>
        <div className="grid grid-cols-3 gap-2.5">
          <select
            className="fld"
            value={stockIdx}
            onChange={(e) => setStockIdx(Number(e.target.value))}
            disabled={offline || FLOOR.stocks.length === 0}
          >
            {FLOOR.stocks.map((s, i) => (
              <option key={s.address} value={i}>
                {s.symbol}
              </option>
            ))}
          </select>
          <input
            className="fld"
            placeholder="ETH amount"
            inputMode="decimal"
            value={ethIn}
            onChange={(e) => setEthIn(e.target.value)}
            disabled={offline}
          />
          <button
            className="btn btn-accent"
            onClick={buy}
            disabled={offline || buyTx.busy || ethWei === undefined}
          >
            Buy
          </button>
        </div>
        {address && ethBal && (
          <p className="label mt-2">Wallet: {Number(formatEther(ethBal.value)).toFixed(4)} ETH</p>
        )}
        <StatusLine msg={buyTx.msg} kind={buyTx.kind} />

        <div className="label mt-3.5">Sell</div>
        <div className="grid grid-cols-3 gap-2.5">
          <input
            className="fld"
            placeholder={`Sell ${stock ? stock.symbol : "stock"}`}
            inputMode="decimal"
            value={sellAmount}
            onChange={(e) => setSellAmount(e.target.value)}
            disabled={offline}
          />
          <label className="flex items-center gap-1.5 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={sellToEth}
              onChange={(e) => setSellToEth(e.target.checked)}
            />
            receive ETH
          </label>
          <button
            className="btn"
            onClick={sell}
            disabled={offline || sellTx.busy || sellWei === undefined}
          >
            {needsApproval ? "Approve + sell" : "Sell"}
          </button>
        </div>
        {address && stock && stockBal !== undefined && (
          <p className="label mt-2">
            You hold {Number(formatUnits(stockBal as bigint, 18)).toFixed(4)} {stock.symbol}
          </p>
        )}
        <StatusLine msg={sellTx.msg} kind={sellTx.kind} />
      </section>

      <p className="text-sm text-ink-soft">
        Non-custodial: stocks land in your wallet in the same transaction, priced against
        Chainlink feeds with an on-chain floor. The {feePct}% fee streams to the machine that
        pays 1,776 Broker salaries.
      </p>
    </div>
  );
}
