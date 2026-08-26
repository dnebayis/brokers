"use client";

import { useEffect, useState } from "react";
import { useAccount, useBalance, useReadContract, useWriteContract } from "wagmi";
import { formatEther, parseEther, parseUnits } from "viem";
import { activeChain } from "@/lib/chains";
import {
  FLOOR,
  floorReady,
  basketRouterAbi,
  erc20MiniAbi,
  boosterEthUsdAbi,
  aggregatorMiniAbi,
  coatRouterQuoteAbi,
} from "@/lib/floor";
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
  const [sellPct, setSellPct] = useState(100);

  // 100% keeps the contract's 0-sentinel (sweep the exact live balance); anything less
  // scales each leg down here.
  const sellPortion = (bal: bigint) => (sellPct === 100 ? bal : (bal * BigInt(sellPct)) / 100n);

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

  const [sellQuote, setSellQuote] = useState<string>("");
  const [buyQuote, setBuyQuote] = useState<string>("");
  const [holdings, setHoldings] = useState<{ symbol: string; text: string }[]>([]);
  const [slipBps, setSlipBps] = useState(100); // 1% default, applied on top of quoted mins
  const applySlip = (x: bigint) => (x * (10000n - BigInt(slipBps))) / 10000n;

  const USDG_ONE = 10n ** BigInt(FLOOR.usdgDecimals);
  const usdgToEthWei = (u: bigint, p8: bigint) =>
    (u * 10n ** BigInt(26 - FLOOR.usdgDecimals)) / p8;
  const ethWeiToUsdg = (e: bigint, p8: bigint) => (e * p8 * USDG_ONE) / 10n ** 26n;

  // ETH/USD from the Booster's own source (feed, else manual fallback) — the same source
  // the contract's guards read, so quote and guard can never disagree on the price.
  async function readEthUsd8(): Promise<bigint> {
    const feed = (await client.readContract({
      address: FLOOR.booster as `0x${string}`,
      abi: boosterEthUsdAbi,
      functionName: "ethUsdFeed",
    })) as `0x${string}`;
    if (BigInt(feed) !== 0n) {
      const rd = (await client.readContract({
        address: feed,
        abi: aggregatorMiniAbi,
        functionName: "latestRoundData",
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      return rd[1];
    }
    return (await client.readContract({
      address: FLOOR.booster as `0x${string}`,
      abi: boosterEthUsdAbi,
      functionName: "ethUsdManualE8",
    })) as bigint;
  }

  // Chainlink floor (fee off) for the selected slice of the position, plus what's held.
  async function readSellFloor(): Promise<{
    held: { symbol: string; text: string }[];
    floorNet: bigint;
  }> {
    let floor = 0n;
    const held: { symbol: string; text: string }[] = [];
    for (const tk of [...livePreset![0]]) {
      const bal = (await client.readContract({
        address: tk,
        abi: erc20MiniAbi,
        functionName: "balanceOf",
        args: [address!],
      })) as bigint;
      if (bal === 0n) continue;
      held.push({
        symbol: symbolOf(tk),
        text: (Number(bal) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 }),
      });
      const amt = sellPortion(bal);
      if (amt === 0n) continue;
      floor += (await client.readContract({
        address: router,
        abi: basketRouterAbi,
        functionName: "minUsdgOut",
        args: [tk, amt],
      })) as bigint;
    }
    return { held, floorNet: (floor * (10000n - (feeBps ?? 30n))) / 10000n };
  }

  // Floor-based minimum in the chosen exit currency: 5% under Chainlink by construction, a
  // 1% conversion buffer on the ETH leg, then the user's slippage on top. Tight enough to
  // kill a sandwich, loose enough never to revert an honest fill.
  async function sellMinOut(floorNet: bigint): Promise<bigint> {
    if (cur === "usdg") return applySlip(floorNet);
    const p8 = await readEthUsd8();
    if (p8 === 0n) return 0n;
    const ethFloor = (usdgToEthWei(floorNet, p8) * 9900n) / 10000n;
    if (cur === "eth") return applySlip(ethFloor);
    const coatFloor = (await client.readContract({
      address: FLOOR.coatRouter as `0x${string}`,
      abi: coatRouterQuoteAbi,
      functionName: "quoteBuy",
      args: [ethFloor],
    })) as bigint;
    return applySlip(coatFloor);
  }

  // Live quotes, both directions: instant on input (150ms debounce), refreshed from chain
  // every 10s so the number on screen never drifts from the pools.
  useEffect(() => {
    if (offline || !livePreset) return;
    let stale = false;

    const refresh = async () => {
      try {
        if (dir === "sell") {
          if (!address) return;
          const { held, floorNet } = await readSellFloor();
          if (stale) return;
          setHoldings(held);
          if (floorNet === 0n) {
            setSellQuote("nothing to sell yet");
            return;
          }
          const est = (floorNet * 10000n) / 9500n; // re-inflate the guard haircut for display
          const usd = Number(est) / 10 ** FLOOR.usdgDecimals;
          if (cur === "usdg") {
            setSellQuote(`≈ ${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDG`);
            return;
          }
          const p8 = await readEthUsd8();
          if (p8 === 0n) {
            setSellQuote(`≈ $${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
            return;
          }
          const ethWei = usdgToEthWei((est * (10000n - (feeBps ?? 30n))) / 10000n, p8);
          if (cur === "eth") {
            if (!stale)
              setSellQuote(
                `≈ ${(Number(ethWei) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 5 })} ETH`,
              );
            return;
          }
          const coatOut = (await client.readContract({
            address: FLOOR.coatRouter as `0x${string}`,
            abi: coatRouterQuoteAbi,
            functionName: "quoteBuy",
            args: [ethWei],
          })) as bigint;
          if (!stale)
            setSellQuote(
              `≈ ${(Number(coatOut) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })} $COAT`,
            );
        } else {
          // buy side: what the payment is worth in basket terms, fee off
          if (amountWei === undefined) {
            setBuyQuote("");
            return;
          }
          let usdgVal: bigint;
          if (cur === "usdg") {
            usdgVal = amountWei;
          } else {
            const p8 = await readEthUsd8();
            if (p8 === 0n) {
              setBuyQuote("");
              return;
            }
            const ethWei =
              cur === "eth"
                ? amountWei
                : ((await client.readContract({
                    address: FLOOR.coatRouter as `0x${string}`,
                    abi: coatRouterQuoteAbi,
                    functionName: "quoteSell",
                    args: [amountWei],
                  })) as bigint);
            usdgVal = ethWeiToUsdg(ethWei, p8);
          }
          const net = (usdgVal * (10000n - (feeBps ?? 30n))) / 10000n;
          const usd = Number(net) / 10 ** FLOOR.usdgDecimals;
          if (!stale)
            setBuyQuote(
              `≈ $${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })} of stocks`,
            );
        }
      } catch {
        if (!stale) {
          if (dir === "sell") setSellQuote("quote unavailable");
          else setBuyQuote("");
        }
      }
    };

    const t = setTimeout(refresh, 150);
    const iv = setInterval(refresh, 10_000);
    return () => {
      stale = true;
      clearTimeout(t);
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, cur, amount, address, offline, livePreset, feeBps, sellPct]);

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
    tx.setStatus(`Approve ${label} once — later trades skip this step…`);
    // max approval: one signature per token, ever. The router can only pull what a trade
    // you sign passes it, so the standing allowance adds no extra exposure.
    const a = await writeContractAsync({
      address: token,
      abi: erc20MiniAbi,
      functionName: "approve",
      args: [router, 2n ** 256n - 1n],
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
      // the COAT->ETH leg runs through the hooked pool, which has no Chainlink floor of its
      // own — quote it live and pin the minimum so a sandwich can't eat the entry
      const ethQuote = (await client.readContract({
        address: FLOOR.coatRouter as `0x${string}`,
        abi: coatRouterQuoteAbi,
        functionName: "quoteSell",
        args: [amountWei],
      })) as bigint;
      tx.setStatus("Confirm in your wallet…");
      const hash = await writeContractAsync({
        address: router,
        abi: basketRouterAbi,
        functionName: "buyBasketCoat",
        args: [0n, amountWei, applySlip(ethQuote), address!, deadline()],
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
    const legsToSell: { t: `0x${string}`; a: bigint }[] = [];
    for (const t of [...livePreset[0]]) {
      const bal = (await client.readContract({
        address: t,
        abi: erc20MiniAbi,
        functionName: "balanceOf",
        args: [address!],
      })) as bigint;
      const amt = sellPortion(bal);
      if (amt === 0n) continue;
      await ensureAllowance(t, bal, symbolOf(t));
      // 0 is the contract's "full live balance" sentinel — used at 100% so dust arriving
      // between this read and the trade still gets swept; partial sells pass the exact cut.
      legsToSell.push({ t, a: sellPct === 100 ? 0n : amt });
    }
    if (legsToSell.length === 0) {
      tx.setStatus("Nothing to sell at this size.", "err");
      return;
    }
    // fresh floor at send time — the on-screen quote may be seconds old
    const { floorNet } = await readSellFloor();
    const minOut = await sellMinOut(floorNet);
    tx.setStatus("Confirm the basket exit…");
    const hash = await writeContractAsync({
      address: router,
      abi: basketRouterAbi,
      functionName: "sellBasket",
      args: [
        legsToSell.map((l) => l.t),
        legsToSell.map((l) => l.a),
        OUT_ENUM[cur],
        minOut,
        address!,
        deadline(),
      ],
    });
    tx.setStatus(
      sellPct === 100
        ? "Selling everything in one transaction…"
        : `Selling ${sellPct}% of your position in one transaction…`,
    );
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
              {holdings.length > 0 && (
                <p className="label mt-2">
                  You hold: {holdings.map((h) => `${h.text} ${h.symbol}`).join(" · ")}
                </p>
              )}
              <div className="flex items-center gap-1.5 mt-2">
                {[25, 50, 75, 100].map((p) => (
                  <button
                    key={p}
                    className={`font-pixel text-xs border-2 border-ink px-2 py-1 ${
                      sellPct === p ? "bg-accent text-cream" : "bg-cream hover:shadow-pixel-sm"
                    }`}
                    onClick={() => setSellPct(p)}
                    disabled={offline}
                  >
                    {p}%
                  </button>
                ))}
              </div>
              <p className="text-sm text-ink-soft mt-1.5">
                {sellPct === 100
                  ? "Your entire position: every basket stock you hold, swept in a single trade."
                  : `${sellPct}% of every basket stock you hold, sold in a single trade.`}
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
              {buyQuote && (
                <div className="font-sans text-xl text-ink-strong mt-2">{buyQuote}</div>
              )}
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
              <div className="font-sans text-2xl text-ink-strong mt-1.5">
                {sellQuote || "—"}
              </div>
              {cur === "coat" && (
                <p className="label mt-2">
                  Proceeds buy $COAT through the hooked pool — the exit feeds the flywheel too.
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between mt-3">
          <span className="label">Max slippage</span>
          <span className="flex gap-1.5">
            {[50, 100, 200].map((b) => (
              <button
                key={b}
                className={`font-pixel text-xs border-2 border-ink px-2 py-0.5 ${
                  slipBps === b ? "bg-accent text-cream" : "bg-cream hover:shadow-pixel-sm"
                }`}
                onClick={() => setSlipBps(b)}
                disabled={offline}
              >
                {b / 100}%
              </button>
            ))}
          </span>
        </div>
        <p className="label mt-2">
          Fee {feePct}% — funds Broker payroll · priced against Chainlink with an on-chain floor
        </p>
        <button
          className="btn btn-accent w-full mt-3"
          onClick={go}
          disabled={offline || tx.busy || (dir === "buy" ? amountWei === undefined : !address)}
        >
          {dir === "buy" ? "Buy basket" : sellPct === 100 ? "Sell entire basket" : `Sell ${sellPct}% of basket`}
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
