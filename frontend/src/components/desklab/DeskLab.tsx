"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { WagmiProvider, createConfig, useAccount, useConnect, useWriteContract, type CreateConnectorFn } from "wagmi";
import { injected, mock } from "wagmi/connectors";
import { useQuery } from "@tanstack/react-query";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { Header } from "@/components/Header";
import { StatusLine, type StatusKind } from "@/components/ui/Status";
import { short } from "@/lib/format";
import { coatRouterAbi, deskAccountAbi, deskNftAbi, depositRouterAbi, erc20Abi } from "./labAbi";
import { readLab, type Activity, type DeskView, type LabConfig, type LabState } from "./labData";

// Local Desk lab: a working surface for the Desk contracts on an anvil fork of testnet,
// started by desk/script/local_env.py. Nothing here reaches a real network: the page talks
// only to the fork's RPC, and the "local test wallet" is an address anvil impersonates.

const E6 = 1_000_000n;
const POLL_MS = 3_000;
const TEST_WALLET_ID = "lab-test-wallet";

export function DeskLabRoot() {
  const [cfg, setCfg] = useState<LabConfig | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    fetch("/desk-local.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("missing"))))
      .then((j: LabConfig) => setCfg(j))
      .catch(() => setMissing(true));
  }, []);
  const lab = useMemo(() => (cfg ? makeLab(cfg) : null), [cfg]);

  if (missing) {
    return (
      <Shell>
        <section className="card max-w-2xl">
          <h1 className="pixel-title text-sm">Desk lab is not running</h1>
          <p className="text-sm text-ink mt-3 leading-relaxed">Start the local fork first, then reload this page:</p>
          <pre className="fld mt-3 text-xs overflow-x-auto">cd desk && python3 script/local_env.py</pre>
        </section>
      </Shell>
    );
  }
  if (!cfg || !lab) return <Shell><p className="text-sm text-ink-soft">Loading the local fork…</p></Shell>;
  return (
    <WagmiProvider config={lab.wagmi}>
      <Shell>
        <Lab cfg={cfg} client={lab.client} faucet={lab.faucet} />
      </Shell>
    </WagmiProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex-1 py-5 lg:py-7">{children}</main>
    </div>
  );
}

function makeLab(cfg: LabConfig) {
  const chain = defineChain({
    id: cfg.chainId,
    name: "Desk lab (local fork)",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
    testnet: true,
  });
  const base = mock({ accounts: [cfg.testWallet], features: { reconnect: true } });
  const testWallet: CreateConnectorFn = (config) => ({ ...base(config), id: TEST_WALLET_ID, name: "Local test wallet" });
  const wagmi = createConfig({
    chains: [chain],
    connectors: [testWallet, injected()],
    transports: { [chain.id]: http(cfg.rpc) },
    // ssr: true defers wagmi's reconnect to an effect; with false it runs during render and
    // updates the Header mid-render (React warns). The config is client-only either way.
    ssr: true,
  });
  const client = createPublicClient({ chain, transport: http(cfg.rpc) }) as PublicClient;
  const faucet = createWalletClient({ chain, transport: http(cfg.rpc), account: cfg.deployer });
  return { wagmi, client, faucet };
}

type Write = ReturnType<typeof useWriteContract>["writeContractAsync"];
type Run = (label: string, steps: (() => Promise<Hex>)[]) => Promise<void>;
type Faucet = ReturnType<typeof makeLab>["faucet"];

function Lab({ cfg, client, faucet }: { cfg: LabConfig; client: PublicClient; faucet: Faucet }) {
  const { address: me, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { writeContractAsync } = useWriteContract();
  const [selected, setSelected] = useState<bigint | null>(null);
  const [status, setStatus] = useState<{ msg: string; kind: StatusKind }>({ msg: "", kind: "" });
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);

  // wagmi's reconnect is guarded by a module-level flag that the site's own wallet provider
  // already holds on load, so the lab's nested provider never gets to reconnect. Restore the
  // test wallet session ourselves when it was the last wallet used. The short delay lets the
  // provider's own hydrate effect (a parent, so it runs after this one) restore its stored
  // state first; connecting before it would be overwritten by that empty stored state.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      let last: string | null = null;
      try {
        last = window.localStorage.getItem("wagmi.recentConnectorId");
      } catch {
        last = null;
      }
      const test = connectors.find((c) => c.id === TEST_WALLET_ID);
      if (test && last === `"${TEST_WALLET_ID}"`) connect({ connector: test });
    }, 300);
    return () => window.clearTimeout(timer);
    // on mount only: a later disconnect must stay disconnected
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const q = useQuery({
    queryKey: ["desk-lab", me, selected?.toString()],
    queryFn: () => readLab(client, cfg, me, selected),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true, // a local lab: keep watching the keeper from another tab
  });
  const s = q.data;
  const desk = s?.desk;

  async function run(label: string, steps: (() => Promise<Hex>)[]) {
    setBusy(true);
    try {
      for (const step of steps) {
        setStatus({ msg: `${label}…`, kind: "" });
        const hash = await step();
        const rc = await client.waitForTransactionReceipt({ hash });
        if (rc.status !== "success") throw new Error("transaction reverted");
      }
      setStatus({ msg: `${label}: done`, kind: "ok" });
      await q.refetch();
    } catch (e) {
      const m = e instanceof Error ? e.message.split("\n")[0] : String(e);
      setStatus({ msg: `${label}: ${m}`, kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  const topUp = () =>
    me &&
    run("Top up", [
      async () => {
        await (client.request as (a: { method: string; params: unknown[] }) => Promise<unknown>)({
          method: "anvil_setBalance",
          params: [me, "0x8ac7230489e80000"], // 10 ETH
        });
        return faucet.writeContract({ address: cfg.coat, abi: erc20Abi, functionName: "transfer", args: [me, parseUnits("200000", 18)], chain: null });
      },
      () => faucet.writeContract({ address: cfg.usdg, abi: erc20Abi, functionName: "mint", args: [me, 2_000n * E6], chain: null }),
    ]);

  const mintDesk = () =>
    s &&
    run("Mint a Desk", [
      () => writeContractAsync({ address: cfg.coat, abi: erc20Abi, functionName: "approve", args: [cfg.desks, s.mintPrice] }),
      () => writeContractAsync({ address: cfg.desks, abi: deskNftAbi, functionName: "mint" }),
    ]);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <StatusStrip cfg={cfg} s={s} now={now} connected={isConnected} busy={busy} onTopUp={topUp} />
      {status.msg && <StatusLine msg={status.msg} kind={status.kind} />}

      {!isConnected ? (
        <section className="card max-w-2xl">
          <h1 className="font-pixel text-xl text-ink-strong">Desk lab</h1>
          <p className="text-sm text-ink mt-3 leading-relaxed">
            The Desk contracts on a local copy of testnet. Connect with <b className="text-ink-strong">Local test wallet</b> in
            the header (already funded), then mint, deposit, withdraw and hand a Desk over as a user would. The keeper buys and
            rebalances in the background. Nothing here touches a real network.
          </p>
        </section>
      ) : (
        <>
          <DeskRail owned={s?.owned ?? []} selected={desk?.id} mintPrice={s?.mintPrice} busy={busy}
            onSelect={setSelected} onMint={mintDesk} />
          {desk && me ? (
            <>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] lg:items-start">
                <Artwork desk={desk} />
                <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
                  <Overview desk={desk} busy={busy} run={run} write={writeContractAsync} />
                  <Actions cfg={cfg} client={client} desk={desk} me={me} ethUsd={s?.ethUsd ?? 0} busy={busy} run={run}
                    write={writeContractAsync} />
                </div>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-2 lg:items-start">
                <Basket s={s} />
                <Timeline activity={(s?.activity ?? []).filter((a) => a.deskId === undefined || a.deskId === desk.id)}
                  now={now} deskId={desk.id} />
              </div>
            </>
          ) : (
            <section className="card max-w-2xl">
              <h2 className="pixel-title text-[15px]">No Desk yet</h2>
              <p className="text-sm text-ink mt-2 leading-relaxed">
                Mint one with the tile above. The COAT price goes to the bonus pool for active Brokers; nothing is burned.
                The Desk comes with its own wallet, which the engine buys into.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// --- top strip -------------------------------------------------------------------------

function StatusStrip({ cfg, s, now, connected, busy, onTopUp }: {
  cfg: LabConfig; s?: LabState; now: number; connected: boolean; busy: boolean; onTopUp: () => void;
}) {
  const ago = s?.keeperLastAt && now ? agoLabel(now - s.keeperLastAt) : null;
  return (
    <div className="border-2 border-ink bg-cream-2 shadow-pixel-sm px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2">
      <span className="chip">Local fork</span>
      <span className="text-xs text-ink-soft tabular-nums">chain {cfg.chainId} · block {s ? s.block.toLocaleString("en-US") : "…"}</span>
      <span className="text-xs text-ink-soft inline-flex items-center gap-1.5">
        <span className={`inline-block w-2 h-2 ${ago ? "bg-good" : "bg-ink-soft"}`} aria-hidden="true" />
        keeper {ago ? `last moved ${ago}` : "waiting for a deposit"}
      </span>
      {connected && s && (
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <Balance label="ETH" value={num(s.eth, 18, 3)} />
          <Balance label="COAT" value={num(s.coat, 18, 0)} />
          <Balance label="USDG" value={num(s.usdg, 6, 2)} />
          <button type="button" className="btn btn-ghost px-3 py-2 text-[10px]" disabled={busy} onClick={onTopUp}>
            Top up
          </button>
        </div>
      )}
    </div>
  );
}

function Balance({ label, value }: { label: string; value: string }) {
  return (
    <span className="tabular-nums">
      <span className="text-ink-soft uppercase tracking-widest text-[10px] mr-1.5">{label}</span>
      <span className="font-pixel text-[11px] text-ink-strong">{value}</span>
    </span>
  );
}

// --- desk switcher ---------------------------------------------------------------------

function DeskRail({ owned, selected, mintPrice, busy, onSelect, onMint }: {
  owned: { id: bigint; image: string }[]; selected?: bigint; mintPrice?: bigint; busy: boolean;
  onSelect: (id: bigint) => void; onMint: () => void;
}) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-1" role="tablist" aria-label="Your desks">
      {owned.map((d) => {
        const on = d.id === selected;
        return (
          <button key={d.id.toString()} type="button" role="tab" aria-selected={on} onClick={() => onSelect(d.id)}
            className={`shrink-0 flex items-center gap-3 border-2 pr-4 bg-cream-2 transition-transform ${on
              ? "border-accent shadow-pixel" : "border-ink hover:-translate-y-0.5"}`}>
            {d.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={d.image} alt="" width={56} height={56} className="block [image-rendering:pixelated]" />
            ) : <span className="w-14 h-14" />}
            <span className={`font-pixel text-[11px] ${on ? "text-accent" : "text-ink-strong"}`}>Desk #{d.id.toString()}</span>
          </button>
        );
      })}
      <button type="button" onClick={onMint} disabled={busy || mintPrice === undefined}
        className="shrink-0 flex flex-col justify-center border-2 border-dashed border-ink px-4 h-[60px] text-left hover:bg-cream-2 disabled:opacity-50">
        <span className="font-pixel text-[11px] text-ink-strong">+ Mint a Desk</span>
        <span className="text-[11px] text-ink-soft">{mintPrice !== undefined ? `${num(mintPrice, 18, 0)} COAT` : "…"}</span>
      </button>
    </div>
  );
}

// --- the desk ----------------------------------------------------------------------------

function Artwork({ desk }: { desk: DeskView }) {
  return (
    <section className="card p-0 overflow-hidden">
      {desk.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={desk.image} alt={`Desk #${desk.id} artwork`} width={420} height={420}
          className="block w-full aspect-square [image-rendering:pixelated] border-b-2 border-ink" />
      ) : <div className="w-full aspect-square border-b-2 border-ink bg-cream" />}
      <div className="p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-pixel text-lg text-ink-strong">Desk #{desk.id.toString()}</h2>
          <span className="text-[11px] text-ink-soft">wallet {short(desk.account)}</span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 mt-4">
          {desk.traits.map((t) => (
            <div key={t.name} className="border-t border-line pt-1.5">
              <dt className="text-[10px] uppercase tracking-widest text-ink-soft">{t.name}</dt>
              <dd className="text-sm text-ink-strong">{t.value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[11px] text-ink-soft mt-4">Traits are fixed at mint. The artwork and wallet move with the NFT.</p>
      </div>
    </section>
  );
}

function Overview({ desk, busy, run, write }: { desk: DeskView; busy: boolean; run: Run; write: Write }) {
  const L = desk.ledger;
  const capPct = desk.cap > 0n ? Math.min(100, Number((desk.deployed * 1000n) / desk.cap) / 10) : 0;
  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[11px] uppercase tracking-widest text-ink-soft">Value now</span>
        <button type="button" disabled={busy}
          onClick={() => run(desk.paused ? "Turn the engine on" : "Pause the engine", [
            () => write({ address: desk.account, abi: deskAccountAbi, functionName: "setEnginePaused", args: [!desk.paused] }),
          ])}
          className={`badge inline-flex items-center gap-2 hover:shadow-pixel-sm ${desk.paused ? "text-ink-soft" : "text-good"}`}
          aria-pressed={!desk.paused} title={desk.paused ? "The keeper cannot touch this Desk" : "The keeper may trade this Desk"}>
          <span className={`inline-block w-2 h-2 ${desk.paused ? "bg-ink-soft" : "bg-good"}`} aria-hidden="true" />
          {desk.paused ? "Engine paused · turn on" : "Engine on · pause"}
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2 mt-1">
        <div className="font-pixel text-3xl text-ink-strong tabular-nums">{usd(desk.totalUsd)}</div>
        <div className={`font-pixel text-lg tabular-nums ${tone(L.pnl)}`}>
          {signed(L.pnl)} <span className="text-sm">({signedPct(L.pnlPct)})</span>
        </div>
      </div>
      <p className="text-[11px] text-ink-soft mt-1">Profit and loss = value now + everything taken out − everything put in.</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        <Stat label="Put in" value={usd(L.deposited)} />
        <Stat label="Taken out" value={usd(L.withdrawn)} />
        <Stat label="Realized" value={signed(L.realized)} toneValue={L.realized} />
        <Stat label="Fees paid" value={usd(L.fees)} />
      </div>

      <div className="overflow-x-auto mt-5">
        <table className="w-full text-sm tabular-nums min-w-[520px]">
          <thead>
            <tr className="text-[10px] text-ink-soft uppercase tracking-widest text-left">
              <th className="py-1.5 font-normal">Stock</th>
              <th className="py-1.5 font-normal">Weight · now vs target</th>
              <th className="py-1.5 font-normal text-right">Value</th>
              <th className="py-1.5 font-normal text-right">Cost</th>
              <th className="py-1.5 font-normal text-right">P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {desk.holdings.map((h) => (
              <tr key={h.token} className="border-t border-line align-middle">
                <td className="py-2 pr-3">
                  <div className="font-pixel text-[11px] text-ink-strong">{h.symbol}</div>
                  <div className="text-[11px] text-ink-soft">{num(h.amount, 18, 4)} @ {usd(h.price)}</div>
                </td>
                <td className="py-2 pr-3 w-[38%]">
                  <WeightBar now={h.weightNow} target={h.target} />
                </td>
                <td className="py-2 text-right">{usd(h.usd)}</td>
                <td className="py-2 text-right text-ink-soft">{h.amount > 0n ? usd(h.cost) : "–"}</td>
                <td className={`py-2 text-right ${tone(h.pnl)}`}>
                  {h.amount > 0n && h.cost > 0 ? (
                    <>
                      <div>{signed(h.pnl)}</div>
                      <div className="text-[11px]">{signedPct((h.pnl / h.cost) * 100)}</div>
                    </>
                  ) : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 mt-5">
        <div>
          <div className="flex justify-between text-[10px] text-ink-soft uppercase tracking-widest">
            <span>Pilot cap used</span>
            <span className="tabular-nums">{usd(Number(desk.deployed) / 1e6, 0)} of {usd(Number(desk.cap) / 1e6, 0)}</span>
          </div>
          <div className="h-2.5 border-2 border-ink mt-1 bg-cream" aria-hidden="true">
            <div className="h-full bg-accent" style={{ width: `${capPct}%` }} />
          </div>
        </div>
        <div className="flex items-end justify-between sm:justify-end gap-3 text-sm">
          <span className="text-ink-soft">Idle USDG</span>
          <span className="font-pixel text-ink-strong tabular-nums">{usd(Number(desk.idle) / 1e6)}</span>
        </div>
      </div>
      {desk.deployed >= desk.cap && desk.idle > 0n && (
        <p className="text-[11px] text-ink-soft mt-2">
          The cap is full, so idle USDG waits. Only money freed by sells is reinvested.
        </p>
      )}
    </section>
  );
}

function WeightBar({ now, target }: { now: number; target: number }) {
  return (
    <div>
      <div className="relative h-2.5 border border-ink bg-cream" aria-hidden="true">
        <div className="absolute inset-y-0 left-0 bg-ink-strong" style={{ width: `${Math.min(100, now)}%` }} />
        {target > 0 && <div className="absolute -top-1 -bottom-1 w-0.5 bg-accent" style={{ left: `calc(${target}% - 1px)` }} />}
      </div>
      <div className="flex justify-between text-[11px] mt-1">
        <span className="text-ink-strong">{now.toFixed(1)}%</span>
        <span className="text-accent">target {target}%</span>
      </div>
    </div>
  );
}

// --- actions -----------------------------------------------------------------------------

type Tab = "deposit" | "withdraw" | "handover";

function Actions(props: {
  cfg: LabConfig; client: PublicClient; desk: DeskView; me: Address; ethUsd: number; busy: boolean; run: Run; write: Write;
}) {
  const [tab, setTab] = useState<Tab>("deposit");
  const tabs: [Tab, string][] = [["deposit", "Deposit"], ["withdraw", "Withdraw"], ["handover", "Hand over"]];
  return (
    <section className="card">
      <div className="flex border-b-2 border-ink -mx-5 sm:-mx-6 -mt-5 sm:-mt-6 mb-5" role="tablist" aria-label="Desk actions">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`flex-1 font-pixel text-[11px] py-3.5 border-r-2 last:border-r-0 border-ink ${tab === k
              ? "bg-ink text-cream" : "bg-cream-2 text-ink-strong hover:bg-cream"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "deposit" && <Deposit {...props} />}
      {tab === "withdraw" && <Withdraw {...props} />}
      {tab === "handover" && <HandOver {...props} />}
    </section>
  );
}

function Deposit({ cfg, client, desk, ethUsd, busy, run, write }: {
  cfg: LabConfig; client: PublicClient; desk: DeskView; ethUsd: number; busy: boolean; run: Run; write: Write;
}) {
  const [cur, setCur] = useState<"USDG" | "ETH" | "COAT">("USDG");
  const [amount, setAmount] = useState("");
  const decimals = cur === "USDG" ? 6 : 18;
  let raw = 0n;
  try {
    raw = parseUnits(amount || "0", decimals);
  } catch {
    raw = 0n;
  }
  const coatQuote = useQuery({
    queryKey: ["lab-coat-quote", raw.toString()],
    queryFn: () => client.readContract({ address: cfg.coatRouter, abi: coatRouterAbi, functionName: "quoteSell", args: [raw] }),
    enabled: cur === "COAT" && raw > 0n,
  });
  const estimate =
    cur === "USDG" ? Number(raw) / 1e6
    : cur === "ETH" ? (Number(raw) / 1e18) * ethUsd * 0.997
    : coatQuote.data !== undefined ? (Number(coatQuote.data) / 1e18) * ethUsd * 0.997 : null;

  const go = () => {
    if (raw === 0n) return;
    if (cur === "USDG") {
      return run(`Deposit ${amount} USDG`, [
        () => write({ address: cfg.usdg, abi: erc20Abi, functionName: "approve", args: [cfg.depositRouter, raw] }),
        () => write({ address: cfg.depositRouter, abi: depositRouterAbi, functionName: "depositUsdg", args: [desk.id, raw] }),
      ]);
    }
    if (cur === "ETH") {
      return run(`Deposit ${amount} ETH`, [
        () => write({ address: cfg.depositRouter, abi: depositRouterAbi, functionName: "depositEth", args: [desk.id, 0n], value: raw }),
      ]);
    }
    return run(`Deposit ${amount} COAT`, [
      () => write({ address: cfg.coat, abi: erc20Abi, functionName: "approve", args: [cfg.depositRouter, raw] }),
      // the testnet COAT pool is thin: the lab takes whatever it pays (the site would quote a floor)
      () => write({ address: cfg.depositRouter, abi: depositRouterAbi, functionName: "depositCoat", args: [desk.id, raw, 1n, 0n] }),
    ]);
  };
  return (
    <div>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Currency">
        {(["USDG", "ETH", "COAT"] as const).map((c) => (
          <button key={c} type="button" role="radio" aria-checked={cur === c}
            className={`btn ${cur === c ? "btn-accent" : "btn-ghost"}`} onClick={() => setCur(c)}>{c}</button>
        ))}
      </div>
      <label className="label mt-4" htmlFor="lab-dep">Amount in {cur}</label>
      <input id="lab-dep" className="fld tabular-nums" inputMode="decimal"
        placeholder={cur === "USDG" ? "500" : cur === "ETH" ? "0.1" : "10000"} value={amount} onChange={(e) => setAmount(e.target.value)} />
      <div className="flex items-baseline justify-between mt-2 text-sm">
        <span className="text-ink-soft">Lands in the Desk as</span>
        <span className="font-pixel text-ink-strong tabular-nums">{raw > 0n && estimate !== null ? `≈ ${usd(estimate)} USDG` : "–"}</span>
      </div>
      <p className="text-[11px] text-ink-soft mt-1">
        {cur === "USDG" ? "Goes into the Desk wallet as is."
          : cur === "ETH" ? "Swapped to USDG at the WETH/USDG pool, floored by the ETH/USD feed."
            : "Sold for ETH on the COAT pool (its fee skim funds the Booster), then swapped to USDG. The testnet COAT pool is thin."}
      </p>
      <button type="button" className="btn btn-accent w-full mt-4" disabled={busy || raw === 0n} onClick={go}>Deposit {cur}</button>
    </div>
  );
}

function Withdraw({ cfg, desk, me, busy, run, write }: { cfg: LabConfig; desk: DeskView; me: Address; busy: boolean; run: Run; write: Write }) {
  const options = [
    { token: cfg.usdg, symbol: "USDG", amount: desk.idle, decimals: 6, usd: Number(desk.idle) / 1e6 },
    ...desk.holdings.filter((h) => h.amount > 0n).map((h) => ({ token: h.token, symbol: h.symbol, amount: h.amount, decimals: 18, usd: h.usd })),
  ];
  const [pick, setPick] = useState(0);
  const [amount, setAmount] = useState("");
  const o = options[Math.min(pick, options.length - 1)];
  let raw = 0n;
  try {
    raw = parseUnits(amount || "0", o.decimals);
  } catch {
    raw = 0n;
  }
  const go = () => {
    if (raw === 0n) return;
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [me, raw] });
    return run(`Withdraw ${amount} ${o.symbol}`, [
      () => write({ address: desk.account, abi: deskAccountAbi, functionName: "execute", args: [o.token, 0n, data, 0] }),
    ]);
  };
  return (
    <div>
      <span className="label">From the Desk wallet</span>
      <div className="grid gap-1.5" role="radiogroup" aria-label="Asset to withdraw">
        {options.map((x, i) => (
          <button key={x.token} type="button" role="radio" aria-checked={pick === i} onClick={() => { setPick(i); setAmount(""); }}
            className={`flex items-center justify-between border-2 px-3 py-2 text-sm ${pick === i ? "border-accent bg-cream" : "border-line bg-cream-2 hover:border-ink"}`}>
            <span className="font-pixel text-[11px] text-ink-strong">{x.symbol}</span>
            <span className="tabular-nums text-ink">{num(x.amount, x.decimals, x.decimals === 6 ? 2 : 4)} <span className="text-ink-soft">· {usd(x.usd)}</span></span>
          </button>
        ))}
      </div>
      <label className="label mt-4" htmlFor="lab-wd">Amount of {o.symbol}</label>
      <div className="flex gap-2">
        <input id="lab-wd" className="fld tabular-nums" inputMode="decimal" placeholder="0" value={amount}
          onChange={(e) => setAmount(e.target.value)} />
        <button type="button" className="btn btn-ghost" onClick={() => setAmount(formatUnits(o.amount, o.decimals))}>Max</button>
      </div>
      <p className="text-[11px] text-ink-soft mt-2">Only the Desk&rsquo;s owner can move assets out. Taking stock out counts in profit and loss at that moment&rsquo;s price.</p>
      <button type="button" className="btn btn-accent w-full mt-4" disabled={busy || raw === 0n || raw > o.amount} onClick={go}>
        Withdraw to my wallet
      </button>
    </div>
  );
}

function HandOver({ cfg, desk, me, busy, run, write }: { cfg: LabConfig; desk: DeskView; me: Address; busy: boolean; run: Run; write: Write }) {
  const [to, setTo] = useState("");
  const valid = /^0x[0-9a-fA-F]{40}$/.test(to) && to.toLowerCase() !== me.toLowerCase();
  return (
    <div>
      <p className="text-sm text-ink leading-relaxed">
        A sale in miniature: Desk #{desk.id.toString()} and everything in its wallet ({usd(desk.totalUsd)} right now) move to
        the new owner. From then on only they can withdraw or pause the engine.
      </p>
      <label className="label mt-4" htmlFor="lab-to">New owner</label>
      <input id="lab-to" className="fld font-mono text-sm" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} />
      <button type="button" className="btn btn-ghost w-full mt-4" disabled={busy || !valid}
        onClick={() => run(`Hand over Desk #${desk.id}`, [
          () => write({ address: cfg.desks, abi: deskNftAbi, functionName: "transferFrom", args: [me, to as Address, desk.id] }),
        ])}>
        Transfer Desk #{desk.id.toString()}
      </button>
    </div>
  );
}

// --- basket and keeper -------------------------------------------------------------------

function Basket({ s }: { s?: LabState }) {
  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <h2 className="pixel-title text-[15px]">Basket</h2>
        <span className="badge">epoch {s ? s.epoch.toString() : "…"}</span>
      </div>
      <div className="grid gap-3 mt-4">
        {(s?.basket ?? []).map((b) => (
          <div key={b.token}>
            <div className="flex justify-between text-sm">
              <span className="font-pixel text-[11px] text-ink-strong">{b.symbol}</span>
              <span className="tabular-nums text-ink">{b.weight}% <span className="text-ink-soft">· {usd(b.price)}</span></span>
            </div>
            <div className="h-2.5 border border-ink mt-1 bg-cream" aria-hidden="true">
              <div className="h-full bg-ink-strong" style={{ width: `${b.weight}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-ink-soft mt-4">
        Changed from the terminal. On a new epoch the keeper sells only what sits above its weight and buys what sits below.
      </p>
    </section>
  );
}

const KIND: Record<Activity["kind"], { label: string; cls: string }> = {
  buy: { label: "Buy", cls: "text-good border-good" },
  sell: { label: "Sell", cls: "text-accent border-accent" },
  fees: { label: "Fees", cls: "text-ink-soft border-ink-soft" },
};

function Timeline({ activity, now, deskId }: { activity: Activity[]; now: number; deskId: bigint }) {
  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <h2 className="pixel-title text-[15px]">Keeper activity</h2>
        <span className="text-[11px] text-ink-soft">Desk #{deskId.toString()} and fee flushes</span>
      </div>
      {activity.length === 0 ? (
        <p className="text-sm text-ink-soft mt-3">Nothing yet. Deposit and the keeper buys within a few seconds.</p>
      ) : (
        <ol className="mt-3 grid">
          {activity.slice(0, 16).map((a) => (
            <li key={`${a.tx}-${a.text}`} className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 py-2 border-t border-line first:border-t-0">
              <span className={`font-pixel text-[9px] border-[1.5px] px-1.5 py-0.5 text-center ${KIND[a.kind].cls}`}>{KIND[a.kind].label}</span>
              <span className="text-sm text-ink truncate">
                {a.text} <span className="font-pixel text-[11px] text-ink-strong tabular-nums">{usd(a.usd)}</span>
              </span>
              <span className="text-[11px] text-ink-soft tabular-nums text-right whitespace-nowrap" title={`block ${a.block} · ${a.tx}`}>
                {now && a.at ? agoLabel(now - a.at) : `#${a.block}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// --- bits ----------------------------------------------------------------------------------

function Stat({ label, value, toneValue }: { label: string; value: string; toneValue?: number }) {
  return (
    <div className="stat">
      <div className="text-[10px] text-ink-soft uppercase tracking-widest">{label}</div>
      <div className={`font-pixel text-[13px] mt-1 tabular-nums ${toneValue === undefined ? "text-ink-strong" : tone(toneValue)}`}>{value}</div>
    </div>
  );
}

function num(v: bigint, decimals: number, precision: number): string {
  const n = Number(formatUnits(v, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: precision, minimumFractionDigits: precision > 2 ? 0 : precision });
}

function usd(n: number, digits = 2): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function signed(n: number): string {
  const r = Math.abs(n) < 0.005 ? 0 : n;
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${usd(Math.abs(r))}`;
}

function signedPct(n: number): string {
  const r = Math.abs(n) < 0.005 ? 0 : n;
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(2)}%`;
}

function tone(n: number): string {
  return Math.abs(n) < 0.005 ? "text-ink-strong" : n > 0 ? "text-good" : "text-accent";
}

function agoLabel(sec: number): string {
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}
