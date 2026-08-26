"use client";

import { useState } from "react";
import { useAccount, useBalance, useReadContract, useWriteContract } from "wagmi";
import { formatEther, parseEther, parseUnits } from "viem";
import { activeChain } from "@/lib/chains";
import { FLOOR, floorReady, basketRouterAbi, erc20MiniAbi } from "@/lib/floor";
import { useTx } from "@/lib/useTx";
import { client, waitForSuccessfulReceipt } from "@/lib/client";
import { Icon } from "@/components/ui/Icon";
import { StatusLine } from "@/components/ui/Status";

const DEADLINE_S = 600n;
const deadline = () => BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_S;

type Cur = "coat" | "eth" | "usdg";
const CUR_LABEL: Record<Cur, string> = { coat: "$COAT", eth: "ETH", usdg: "USDG" };
const OUT_ENUM: Record<Cur, number> = { usdg: 0, eth: 1, coat: 2 }; // BasketRouter.OutCurrency

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ONE classic swap window. Direction flips between:
//   buy:  you pay COAT/ETH/USDG  ->  you receive the whole basket, one transaction
//   sell: you sell your whole basket position -> you receive COAT/ETH/USDG, one transaction
export function Terminal() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const tx = useTx();

  const [dir, setDir] = useState<"buy" | "sell">("buy");
  const [cur, setCur] = useState<Cur>(FLOOR.coat !== "" ? "coat" : "eth");
  const [amount, setAmount] = useState("");

  const router = FLOOR.router as `0x${string}`;
  const offline = !floorReady;
  const currencies: Cur[] = FLOOR.coat !== "" ? ["coat", "eth", "usdg"] : ["eth", "usdg"];

  const { data: ethBal } = useBalance({ address, chainId: activeChain.id });
  const { data: coatBal } = useReadContract({
    address: FLOOR.coat !== "" ? (FLOOR.coat as `0x${string}`) : undefined,
    abi: erc20MiniAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && FLOOR.coat !== "" },
  });
  const { data: usdgBal } = useReadContract({
    address: FLOOR.usdg !== "" ? (FLOOR.usdg as `0x${string}`) : undefined,
    abi: erc20MiniAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && FLOOR.usdg !== "" },
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

  const feePct = feeBps !== undefined ? Number(feeBps) / 100 : 0.3;
  const presetName = livePreset ? livePreset[2] : FLOOR.presets[0].name;
  const symbolOf = (a: string) =>
    FLOOR.stocks.find((s) => s.address.toLowerCase() === a.toLowerCase())?.symbol ?? short(a);
  const legs = livePreset
    ? livePreset[0].map((t, i) => ({ symbol: symbolOf(t), pct: Number(livePreset[1][i]) / 100 }))
    : [];

  const decimalsOf = (c: Cur) => (c === "usdg" ? FLOOR.usdgDecimals : 18);
  let amountWei: bigint | undefined;
  try {
    amountWei =
      amount && Number(amount) > 0 ? parseUnits(amount, decimalsOf(cur)) : undefined;
  } catch {
    amountWei = undefined;
  }

  const balOf = (c: Cur): bigint | undefined =>
    c === "eth" ? ethBal?.value : c === "coat" ? (coatBal as bigint | undefined) : (usdgBal as bigint | undefined);
  const fmtBal = (c: Cur) => {
    const b = balOf(c);
    if (b === undefined) return "";
    const n = Number(b) / 10 ** decimalsOf(c);
    return `Balance: ${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  };

  async function ensureAllowance(token: `0x${string}`, needed: bigint, label: string) {
    const cur_ = (await client.readContract({
      address: token,
      abi: erc20MiniAbi,
      functionName: "allowance",
      args: [address!, router],
    })) as bigint;
    if (cur_ >= needed) return;
    tx.setStatus(`Approve ${label} first…`);
    const a = await writeContractAsync({
      address: token,
      abi: erc20MiniAbi,
      functionName: "approve",
      args: [router, needed],
    });
    await waitForSuccessfulReceipt(a);
  }

  async function doBuy() {
    if (amountWei === undefined) return;
    if (cur === "eth") {
      tx.setStatus("Confirm in your wallet…");
      const hash = await writeContractAsync({
        address: router,
        abi: basketRouterAbi,
        functionName: "buyBasketEth",
        args: [0n, address!, deadline()],
        value: amountWei,
      });
      tx.setStatus("Buying every stock in one transaction…");
      await waitForSuccessfulReceipt(hash);
    } else if (cur === "coat") {
      await ensureAllowance(FLOOR.coat as `0x${string}`, amountWei, "$COAT");
      tx.setStatus("Confirm in your wallet…");
      const hash = await writeContractAsync({
        address: router,
        abi: basketRouterAbi,
        functionName: "buyBasketCoat",
        args: [0n, amountWei, 0n, address!, deadline()],
      });
      tx.setStatus("Selling $COAT through the hooked pool, buying the basket…");
      await waitForSuccessfulReceipt(hash);
    } else {
      await ensureAllowance(FLOOR.usdg as `0x${string}`, amountWei, "USDG");
      tx.setStatus("Confirm in your wallet…");
      const hash = await writeContractAsync({
        address: router,
        abi: basketRouterAbi,
        functionName: "buyBasket",
        args: [0n, amountWei, address!, deadline()],
      });
      tx.setStatus("Buying every stock in one transaction…");
      await waitForSuccessfulReceipt(hash);
    }
    tx.setStatus("Basket delivered — every stock is in your wallet.", "ok");
    setAmount("");
  }

  async function doSell() {
    if (!livePreset) return;
    const tokens = [...livePreset[0]];
    for (const t of tokens) {
      const bal = (await client.readContract({
        address: t,
        abi: erc20MiniAbi,
        functionName: "balanceOf",
        args: [address!],
      })) as bigint;
      if (bal === 0n) continue;
      await ensureAllowance(t, bal, symbolOf(t));
    }
    tx.setStatus("Confirm the basket exit…");
    const hash = await writeContractAsync({
      address: router,
      abi: basketRouterAbi,
      functionName: "sellBasket",
      args: [tokens, tokens.map(() => 0n), OUT_ENUM[cur], 0n, address!, deadline()],
    });
    tx.setStatus("Selling everything in one transaction…");
    await waitForSuccessfulReceipt(hash);
    tx.setStatus(`Basket sold — ${CUR_LABEL[cur]} is in your wallet.`, "ok");
  }

  async function go() {
    await tx.run(async () => (dir === "buy" ? doBuy() : doSell()));
  }

  const currencySelect = (
    <select
      className="font-pixel text-xs border-2 border-ink bg-cream px-2 py-2 shrink-0"
      value={cur}
      onChange={(e) => setCur(e.target.value as Cur)}
      disabled={offline}
    >
      {currencies.map((c) => (
        <option key={c} value={c}>
          {CUR_LABEL[c]}
        </option>
      ))}
    </select>
  );

  const basketPanel = (
    <div>
      <div className="font-sans text-lg text-ink-strong">{presetName}</div>
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
    </div>
  );

  return (
    <div className="space-y-6">
      {offline && (
        <div className="border-l-[3px] border-accent bg-cream-2 px-4 py-3 text-sm">
          The trading venue is not wired on this network yet — preview only.
        </div>
      )}

      <section className="card max-w-xl">
        {/* top panel */}
        <div className="bg-cream-2 border-2 border-ink p-3">
          {dir === "buy" ? (
            <>
              <div className="flex items-center justify-between">
                <span className="label">You pay</span>
                <span className="label">{address ? fmtBal(cur) : ""}</span>
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
                {currencySelect}
              </div>
            </>
          ) : (
            <>
              <span className="label">You sell — one transaction</span>
              <div className="mt-1.5">{basketPanel}</div>
              <p className="text-sm text-ink-soft mt-1">
                Your entire position: every basket stock you hold, swept in a single trade.
              </p>
            </>
          )}
        </div>

        {/* flip */}
        <div className="flex justify-center -my-2.5 relative z-10">
          <button
            aria-label="flip direction"
            className="border-2 border-ink bg-cream px-2.5 py-1 hover:shadow-pixel-sm"
            onClick={() => {
              setDir(dir === "buy" ? "sell" : "buy");
              setAmount("");
            }}
            disabled={offline}
          >
            <Icon name="swap" className="w-4 h-4 rotate-90" />
          </button>
        </div>

        {/* bottom panel */}
        <div className="bg-cream-2 border-2 border-ink p-3">
          {dir === "buy" ? (
            <>
              <span className="label">You receive — one transaction</span>
              <div className="mt-1.5">{basketPanel}</div>
              {cur === "coat" && (
                <p className="label mt-2">
                  $COAT is sold through the hooked pool first — that trade feeds the flywheel too.
                </p>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="label">You receive</span>
                {currencySelect}
              </div>
              {cur === "coat" && (
                <p className="label mt-2">
                  Proceeds buy $COAT through the hooked pool — the exit feeds the flywheel too.
                </p>
              )}
            </>
          )}
        </div>

        <p className="label mt-3">
          Fee {feePct}% — funds Broker payroll · priced against Chainlink with an on-chain floor
        </p>
        <button
          className="btn btn-accent w-full mt-3"
          onClick={go}
          disabled={offline || tx.busy || (dir === "buy" ? amountWei === undefined : !address)}
        >
          {dir === "buy" ? "Buy basket" : "Sell entire basket"}
        </button>
        <StatusLine msg={tx.msg} kind={tx.kind} />
      </section>

      <p className="text-sm text-ink-soft max-w-xl">
        Non-custodial: everything settles into your wallet in the same transaction. The {feePct}%
        fee streams to the machine that pays 1,776 Broker salaries.
      </p>
    </div>
  );
}
