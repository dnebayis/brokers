"use client";

import { useState } from "react";
import { useAccount, useBalance, useReadContract, useWriteContract } from "wagmi";
import { formatEther, formatUnits, parseUnits } from "viem";
import { activeChain } from "@/lib/chains";
import { FLOOR, floorReady, basketRouterAbi, erc20MiniAbi } from "@/lib/floor";
import { useTx } from "@/lib/useTx";
import { client, waitForSuccessfulReceipt } from "@/lib/client";
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

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Basket-only terminal: you buy the whole live basket (with ETH or $COAT) or exit the whole
// thing, always in one transaction. No single-stock swapping — the product IS the basket.
export function Terminal() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const buyTx = useTx();
  const sellTx = useTx();

  const coatAvailable = FLOOR.coat !== "";
  const [payWith, setPayWith] = useState<"eth" | "coat">(coatAvailable ? "coat" : "eth");
  const [amount, setAmount] = useState("");
  const [sellOutEth, setSellOutEth] = useState(true);

  const router = FLOOR.router as `0x${string}`;
  const offline = !floorReady;

  const { data: ethBal } = useBalance({ address, chainId: activeChain.id });
  const { data: coatBal } = useReadContract({
    address: coatAvailable ? (FLOOR.coat as `0x${string}`) : undefined,
    abi: erc20MiniAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && coatAvailable },
  });
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

  const amountWei = parse18(amount);
  const feePct = feeBps !== undefined ? Number(feeBps) / 100 : 0.3;
  const presetName = livePreset ? livePreset[2] : FLOOR.presets[0].name;
  const symbolOf = (addr: string) =>
    FLOOR.stocks.find((s) => s.address.toLowerCase() === addr.toLowerCase())?.symbol ?? short(addr);
  const legs = livePreset
    ? livePreset[0].map((t, i) => ({ symbol: symbolOf(t), pct: Number(livePreset[1][i]) / 100 }))
    : [];

  const payBal =
    payWith === "eth" ? ethBal?.value : coatAvailable ? (coatBal as bigint | undefined) : undefined;

  async function doBuy() {
    if (amountWei === undefined) return;
    await buyTx.run(async () => {
      if (payWith === "eth") {
        buyTx.setStatus("Confirm in your wallet…");
        const hash = await writeContractAsync({
          address: router,
          abi: basketRouterAbi,
          functionName: "buyBasketEth",
          args: [0n, address!, deadline()],
          value: amountWei,
        });
        buyTx.setStatus("Buying every stock in one transaction…");
        await waitForSuccessfulReceipt(hash);
      } else {
        const coatAddr = FLOOR.coat as `0x${string}`;
        const cur = (await client.readContract({
          address: coatAddr,
          abi: erc20MiniAbi,
          functionName: "allowance",
          args: [address!, router],
        })) as bigint;
        if (cur < amountWei) {
          buyTx.setStatus("Approve $COAT first…");
          const a = await writeContractAsync({
            address: coatAddr,
            abi: erc20MiniAbi,
            functionName: "approve",
            args: [router, amountWei],
          });
          await waitForSuccessfulReceipt(a);
        }
        buyTx.setStatus("Confirm in your wallet…");
        const hash = await writeContractAsync({
          address: router,
          abi: basketRouterAbi,
          functionName: "buyBasketCoat",
          args: [0n, amountWei, 0n, address!, deadline()],
        });
        buyTx.setStatus("Selling $COAT through the hooked pool, buying the basket…");
        await waitForSuccessfulReceipt(hash);
      }
      buyTx.setStatus("Basket delivered — every stock is in your wallet.", "ok");
      setAmount("");
    });
  }

  async function doSellAll() {
    if (!livePreset) return;
    await sellTx.run(async () => {
      const tokens = [...livePreset[0]];
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
          sellTx.setStatus("Approving basket stocks…");
          const a = await writeContractAsync({
            address: t,
            abi: erc20MiniAbi,
            functionName: "approve",
            args: [router, bal],
          });
          await waitForSuccessfulReceipt(a);
        }
      }
      sellTx.setStatus("Confirm the basket exit…");
      const hash = await writeContractAsync({
        address: router,
        abi: basketRouterAbi,
        functionName: "sellBasket",
        args: [tokens, tokens.map(() => 0n), sellOutEth, 0n, address!, deadline()],
      });
      sellTx.setStatus("Selling everything in one transaction…");
      await waitForSuccessfulReceipt(hash);
      sellTx.setStatus(`Basket sold — ${sellOutEth ? "ETH" : "USDG"} is in your wallet.`, "ok");
    });
  }

  return (
    <div className="space-y-6">
      {offline && (
        <div className="border-l-[3px] border-accent bg-cream-2 px-4 py-3 text-sm">
          The trading venue is not wired on this network yet — preview only.
        </div>
      )}

      {/* BUY — classic swap shape: pay panel, receive panel, one big button */}
      <section className="card max-w-xl">
        <h2 className="pixel-title text-[15px] mb-3">Buy the basket</h2>

        <div className="bg-cream-2 border-2 border-ink p-3">
          <div className="flex items-center justify-between">
            <span className="label">You pay</span>
            <span className="label">
              {address && payBal !== undefined
                ? `Balance: ${Number(formatEther(payBal)).toLocaleString("en-US", { maximumFractionDigits: 4 })}`
                : ""}
            </span>
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
            {coatAvailable ? (
              <select
                className="font-pixel text-xs border-2 border-ink bg-cream px-2 py-2 shrink-0"
                value={payWith}
                onChange={(e) => setPayWith(e.target.value as "eth" | "coat")}
                disabled={offline}
              >
                <option value="coat">$COAT</option>
                <option value="eth">ETH</option>
              </select>
            ) : (
              <span className="font-pixel text-xs border-2 border-ink px-3 py-2 shrink-0">ETH</span>
            )}
          </div>
        </div>

        <div className="bg-cream-2 border-2 border-ink p-3 mt-2">
          <span className="label">You receive — one transaction</span>
          <div className="font-sans text-lg text-ink-strong mt-1">{presetName}</div>
          {legs.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {legs.map((l) => (
                <li key={l.symbol} className="flex items-center gap-2 text-sm">
                  <span className="font-pixel text-xs text-ink-strong w-16">{l.symbol}</span>
                  <span className="flex-1 h-2 bg-cream border border-ink overflow-hidden">
                    <span className="block h-full bg-accent" style={{ width: `${l.pct}%` }} />
                  </span>
                  <span className="text-ink-soft w-14 text-right">{l.pct.toFixed(1)}%</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-soft mt-0.5">{FLOOR.presets[0].blurb}</p>
          )}
          {payWith === "coat" && (
            <p className="label mt-2">
              $COAT is sold through the hooked pool first — that trade feeds the flywheel too.
            </p>
          )}
        </div>

        <p className="label mt-3">
          Fee {feePct}% — funds Broker payroll · priced against Chainlink with an on-chain floor
        </p>
        <button
          className="btn btn-accent w-full mt-3"
          onClick={doBuy}
          disabled={offline || buyTx.busy || amountWei === undefined}
        >
          Buy basket
        </button>
        <StatusLine msg={buyTx.msg} kind={buyTx.kind} />
      </section>

      {/* SELL ALL — the mirror: whole position out in one transaction */}
      <section className="card max-w-xl">
        <h2 className="pixel-title text-[15px] mb-3">Sell the basket</h2>
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
              value={sellOutEth ? "eth" : "usdg"}
              onChange={(e) => setSellOutEth(e.target.value === "eth")}
              disabled={offline}
            >
              <option value="eth">ETH</option>
              <option value="usdg">USDG</option>
            </select>
          </div>
        </div>
        <button
          className="btn w-full mt-3"
          onClick={doSellAll}
          disabled={offline || sellTx.busy || !address}
        >
          Sell entire basket
        </button>
        <StatusLine msg={sellTx.msg} kind={sellTx.kind} />
      </section>

      <p className="text-sm text-ink-soft max-w-xl">
        Non-custodial: everything settles into your wallet in the same transaction. The {feePct}%
        fee streams to the machine that pays 1,776 Broker salaries.
      </p>
    </div>
  );
}
