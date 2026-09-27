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
import {
  boosterFeedAbi,
  coatRouterAbi,
  deskAccountAbi,
  deskEngineAbi,
  deskNftAbi,
  depositRouterAbi,
  erc20Abi,
  feedAbi,
  registryAbi,
} from "./labAbi";

// Local Desk lab: a working surface for the Desk contracts on an anvil fork of testnet,
// started by desk/script/local_env.py. Nothing here reaches a real network: the page talks
// only to the fork's RPC, and the "local test wallet" is an address anvil impersonates.

type LabConfig = {
  rpc: string;
  chainId: number;
  forkBlock?: number;
  testWallet: Address;
  deployer: Address;
  symbols: Record<string, string>;
  usdg: Address;
  coat: Address;
  weth: Address;
  desks: Address;
  engine: Address;
  registry: Address;
  booster: Address;
  depositRouter: Address;
  coatRouter: Address;
  taapl: Address;
  tmsft: Address;
  tnvda: Address;
  strategyId: number;
};

const E6 = 1_000_000n;
const POLL_MS = 3_000;

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
          <p className="text-sm text-ink mt-3 leading-relaxed">
            Start the local fork first, then reload this page:
          </p>
          <pre className="fld mt-3 text-xs overflow-x-auto">cd desk && python3 script/local_env.py</pre>
        </section>
      </Shell>
    );
  }
  if (!cfg || !lab) return <Shell><p className="text-sm text-ink-soft">Loading the local fork…</p></Shell>;
  return (
    <WagmiProvider config={lab.wagmi}>
      <Shell>
        <Lab cfg={cfg} client={lab.client} />
      </Shell>
    </WagmiProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex-1 py-6 lg:py-8">{children}</main>
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
  return { wagmi, client, faucet, chain };
}

type Holding = { token: Address; symbol: string; amount: bigint; usd: number; weightNow: number; target: number };
type Activity = { block: bigint; text: string; tx: Hex };

type LabState = {
  block: bigint;
  eth: bigint;
  coat: bigint;
  usdg: bigint;
  mintPrice: bigint;
  owned: bigint[];
  basket: { token: Address; symbol: string; weight: number }[];
  epoch: bigint;
  prices: Record<string, number>;
  desk?: {
    id: bigint;
    account: Address;
    image: string;
    paused: boolean;
    idle: bigint;
    deployed: bigint;
    cap: bigint;
    holdings: Holding[];
    totalUsd: number;
  };
  activity: Activity[];
};

async function readLab(client: PublicClient, cfg: LabConfig, me: Address | undefined, selected: bigint | null): Promise<LabState> {
  const stocks = [cfg.taapl, cfg.tmsft, cfg.tnvda];
  const sym = (t: string) => cfg.symbols[t] ?? cfg.symbols[t.toLowerCase()] ?? short(t);
  const [block, mintPrice, totalMinted, basketRaw] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({ address: cfg.desks, abi: deskNftAbi, functionName: "mintPrice" }),
    client.readContract({ address: cfg.desks, abi: deskNftAbi, functionName: "totalMinted" }),
    client.readContract({ address: cfg.registry, abi: registryAbi, functionName: "getBasket", args: [BigInt(cfg.strategyId)] }),
  ]);
  const prices: Record<string, number> = {};
  await Promise.all(
    stocks.map(async (t) => {
      const feed = await client.readContract({ address: cfg.booster, abi: boosterFeedAbi, functionName: "stockFeed", args: [t] });
      const round = await client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" });
      prices[t.toLowerCase()] = Number(round[1]) / 1e8;
    }),
  );
  const basket = basketRaw[0].map((t, i) => ({ token: t, symbol: sym(t), weight: basketRaw[1][i] / 100 }));

  let eth = 0n, coat = 0n, usdg = 0n;
  const owned: bigint[] = [];
  if (me) {
    [eth, coat, usdg] = await Promise.all([
      client.getBalance({ address: me }),
      client.readContract({ address: cfg.coat, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
      client.readContract({ address: cfg.usdg, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
    ]);
    const ids = Array.from({ length: Number(totalMinted) }, (_, i) => BigInt(i + 1));
    const owners = await Promise.all(
      ids.map((id) => client.readContract({ address: cfg.desks, abi: deskNftAbi, functionName: "ownerOf", args: [id] })),
    );
    ids.forEach((id, i) => owners[i].toLowerCase() === me.toLowerCase() && owned.push(id));
  }

  const state: LabState = { block, eth, coat, usdg, mintPrice, owned, basket, epoch: basketRaw[2], prices, activity: [] };
  const id = selected && selected <= totalMinted ? selected : owned[0];
  if (id) {
    const account = await client.readContract({ address: cfg.desks, abi: deskNftAbi, functionName: "accountOf", args: [id] });
    const [uri, paused, idle, deployed, cap, amounts] = await Promise.all([
      client.readContract({ address: cfg.desks, abi: deskNftAbi, functionName: "tokenURI", args: [id] }),
      client.readContract({ address: account, abi: deskAccountAbi, functionName: "enginePaused" }),
      client.readContract({ address: cfg.usdg, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      client.readContract({ address: cfg.engine, abi: deskEngineAbi, functionName: "deployedUsdg", args: [id] }),
      client.readContract({ address: cfg.engine, abi: deskEngineAbi, functionName: "pilotCapUsdg" }),
      Promise.all(stocks.map((t) => client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [account] }))),
    ]);
    const usd = stocks.map((t, i) => (Number(amounts[i]) / 1e18) * prices[t.toLowerCase()]);
    const stockUsd = usd.reduce((x, y) => x + y, 0);
    const targets: Record<string, number> = {};
    basket.forEach((b) => (targets[b.token.toLowerCase()] = b.weight));
    const holdings = stocks
      .map((t, i) => ({
        token: t,
        symbol: sym(t),
        amount: amounts[i],
        usd: usd[i],
        weightNow: stockUsd > 0 ? (usd[i] / stockUsd) * 100 : 0,
        target: targets[t.toLowerCase()] ?? 0,
      }))
      .filter((h) => h.amount > 0n || h.target > 0);
    let image = "";
    try {
      const json = JSON.parse(atob(uri.split(",")[1] ?? "")) as { image?: string };
      image = json.image ?? "";
    } catch {
      image = "";
    }
    state.desk = { id, account, image, paused, idle, deployed, cap, holdings, totalUsd: stockUsd + Number(idle) / 1e6 };

    const from = cfg.forkBlock ? BigInt(cfg.forkBlock) : block > 20_000n ? block - 20_000n : 0n;
    const logs = await client.getContractEvents({ address: cfg.engine, abi: deskEngineAbi, fromBlock: from, toBlock: block });
    for (const l of logs) {
      const args = l.args as Record<string, unknown>;
      if ("deskId" in args && args.deskId !== id) continue;
      const usdOf = (v: unknown) => `$${(Number(v as bigint) / 1e6).toFixed(2)}`;
      let text = "";
      if (l.eventName === "BasketBought") text = `bought the basket with ${usdOf(args.usdgSpent)} (epoch ${args.epoch})`;
      else if (l.eventName === "StockBought") text = `bought ${sym(args.stock as string)} with ${usdOf(args.usdgSpent)}`;
      else if (l.eventName === "StockSold") text = `sold ${sym(args.stock as string)} for ${usdOf(args.usdgOut)}`;
      else if (l.eventName === "FeesFlushed") text = `fees ${usdOf(args.usdgIn)} sent to the Booster and treasury as ETH`;
      if (text) state.activity.push({ block: l.blockNumber ?? 0n, text, tx: l.transactionHash as Hex });
    }
    state.activity.reverse();
  }
  return state;
}

const TEST_WALLET_ID = "lab-test-wallet";

function Lab({ cfg, client }: { cfg: LabConfig; client: PublicClient }) {
  const { address: me, isConnected } = useAccount();
  const { connectors, connect } = useConnect();

  // wagmi's reconnect is guarded by a module-level flag that the site's own wallet provider
  // already holds on load, so the lab's nested provider never gets to reconnect. Restore the
  // test wallet session ourselves when it was the last wallet used.
  useEffect(() => {
    let last: string | null = null;
    try {
      last = window.localStorage.getItem("wagmi.recentConnectorId");
    } catch {
      last = null;
    }
    const test = connectors.find((c) => c.id === TEST_WALLET_ID);
    if (!isConnected && test && last === `"${TEST_WALLET_ID}"`) connect({ connector: test });
    // on mount only: a later disconnect must stay disconnected
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { writeContractAsync } = useWriteContract();
  const [selected, setSelected] = useState<bigint | null>(null);
  const [status, setStatus] = useState<{ msg: string; kind: StatusKind }>({ msg: "", kind: "" });
  const [busy, setBusy] = useState(false);
  const faucet = useMemo(() => makeLab(cfg).faucet, [cfg]);

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
          params: [me, "0x8ac7230489e80000"],
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
    <div className="grid gap-5">
      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="chip inline-block">Local fork · chain {cfg.chainId}</p>
            <h1 className="font-pixel text-xl text-ink-strong mt-2">Desk lab</h1>
            <p className="text-sm text-ink-soft mt-1 max-w-2xl">
              The Desk contracts on a local copy of testnet. Mint, deposit, withdraw and sell as a user would;
              the keeper buys and rebalances in the background. Nothing here touches a real network.
            </p>
          </div>
          <div className="text-right text-xs text-ink-soft">
            <div>block {s ? s.block.toLocaleString("en-US") : "…"}</div>
            <div>{cfg.rpc}</div>
          </div>
        </div>
        {!isConnected ? (
          <p className="text-sm text-ink mt-4">
            Connect with <b className="text-ink-strong">Local test wallet</b> from the header (already funded), or a browser
            wallet pointed at {cfg.rpc}.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <Stat label="Wallet" value={short(me)} />
            <Stat label="ETH" value={s ? num(s.eth, 18, 3) : "…"} />
            <Stat label="COAT" value={s ? num(s.coat, 18, 0) : "…"} />
            <Stat label="Test USDG" value={s ? num(s.usdg, 6, 2) : "…"} />
          </div>
        )}
        {isConnected && (
          <div className="flex flex-wrap gap-2 mt-3">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={topUp}>Top up test funds</button>
            <button type="button" className="btn btn-accent" disabled={busy || !s} onClick={mintDesk}>
              Mint a Desk{s ? ` · ${num(s.mintPrice, 18, 0)} COAT` : ""}
            </button>
          </div>
        )}
        <StatusLine msg={status.msg} kind={status.kind} />
      </section>

      {isConnected && s && s.owned.length > 0 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Your desks">
          {s.owned.map((id) => (
            <button key={id.toString()} type="button" role="tab" aria-selected={desk?.id === id}
              className={`btn ${desk?.id === id ? "btn-accent" : "btn-ghost"}`} onClick={() => setSelected(id)}>
              Desk #{id.toString()}
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start">
        <div className="grid gap-5">
          {desk ? (
            <DeskCard desk={desk} busy={busy} run={run} write={writeContractAsync} />
          ) : (
            <section className="card">
              <h2 className="pixel-title text-[15px]">No Desk yet</h2>
              <p className="text-sm text-ink-soft mt-2">Mint one above. It costs COAT, which goes to the bonus pool for active Brokers.</p>
            </section>
          )}
          <Activity activity={s?.activity ?? []} />
        </div>
        <div className="grid gap-5">
          <Basket s={s} />
          {desk && me && (
            <>
              <Deposit cfg={cfg} client={client} deskId={desk.id} busy={busy} run={run} write={writeContractAsync} />
              <Withdraw cfg={cfg} desk={desk} me={me} busy={busy} run={run} write={writeContractAsync} />
              <Sell cfg={cfg} deskId={desk.id} me={me} busy={busy} run={run} write={writeContractAsync} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type Write = ReturnType<typeof useWriteContract>["writeContractAsync"];
type Run = (label: string, steps: (() => Promise<Hex>)[]) => Promise<void>;

function DeskCard({ desk, busy, run, write }: { desk: NonNullable<LabState["desk"]>; busy: boolean; run: Run; write: Write }) {
  const capPct = desk.cap > 0n ? Number((desk.deployed * 1000n) / desk.cap) / 10 : 0;
  return (
    <section className="card">
      <div className="flex flex-wrap items-start gap-4">
        {desk.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={desk.image} alt={`Desk #${desk.id} artwork`} width={120} height={120}
            className="border-2 border-ink shadow-pixel-sm [image-rendering:pixelated]" />
        ) : null}
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center justify-between gap-2">
            <h2 className="pixel-title text-[15px]">Desk #{desk.id.toString()}</h2>
            <span className={`badge ${desk.paused ? "" : "text-good"}`}>{desk.paused ? "Engine paused" : "Engine on"}</span>
          </div>
          <p className="text-xs text-ink-soft mt-1">Wallet {short(desk.account)}</p>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Stat label="Value" value={`$${desk.totalUsd.toFixed(2)}`} />
            <Stat label="Idle USDG" value={`$${num(desk.idle, 6, 2)}`} />
          </div>
          <div className="mt-3">
            <div className="flex justify-between text-[11px] text-ink-soft uppercase tracking-widest">
              <span>Pilot cap used</span>
              <span className="tabular-nums">${num(desk.deployed, 6, 0)} of ${num(desk.cap, 6, 0)}</span>
            </div>
            <div className="h-2 border border-ink mt-1" aria-hidden="true">
              <div className="h-full bg-accent" style={{ width: `${Math.min(100, capPct)}%` }} />
            </div>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto mt-4">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-[11px] text-ink-soft uppercase tracking-widest text-left">
              <th className="py-1.5 font-normal">Stock</th>
              <th className="py-1.5 font-normal text-right">Shares</th>
              <th className="py-1.5 font-normal text-right">Value</th>
              <th className="py-1.5 font-normal text-right">Now</th>
              <th className="py-1.5 font-normal text-right">Target</th>
            </tr>
          </thead>
          <tbody>
            {desk.holdings.map((h) => (
              <tr key={h.token} className="border-t border-line">
                <td className="py-1.5 font-pixel text-[11px] text-ink-strong">{h.symbol}</td>
                <td className="py-1.5 text-right">{num(h.amount, 18, 4)}</td>
                <td className="py-1.5 text-right">${h.usd.toFixed(2)}</td>
                <td className="py-1.5 text-right">{h.weightNow.toFixed(1)}%</td>
                <td className="py-1.5 text-right text-ink-soft">{h.target}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn btn-ghost mt-4" disabled={busy}
        onClick={() => run(desk.paused ? "Turn the engine on" : "Pause the engine", [
          () => write({ address: desk.account, abi: deskAccountAbi, functionName: "setEnginePaused", args: [!desk.paused] }),
        ])}>
        {desk.paused ? "Turn the engine on" : "Pause the engine"}
      </button>
      <p className="text-xs text-ink-soft mt-2">Paused, the keeper cannot move anything in this Desk.</p>
    </section>
  );
}

function Basket({ s }: { s?: LabState }) {
  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <h2 className="pixel-title text-[15px]">Basket</h2>
        <span className="text-[11px] text-ink-soft">epoch {s ? s.epoch.toString() : "…"}</span>
      </div>
      <div className="grid gap-2 mt-3">
        {(s?.basket ?? []).map((b) => (
          <div key={b.token}>
            <div className="flex justify-between text-sm">
              <span className="font-pixel text-[11px] text-ink-strong">{b.symbol}</span>
              <span className="tabular-nums">
                {b.weight}% <span className="text-ink-soft text-xs">· ${(s?.prices[b.token.toLowerCase()] ?? 0).toFixed(2)}</span>
              </span>
            </div>
            <div className="h-2 border border-ink mt-1" aria-hidden="true">
              <div className="h-full bg-ink-strong" style={{ width: `${b.weight}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-soft mt-3">Changed from the terminal. When it moves, the keeper trades only the difference.</p>
    </section>
  );
}

function Activity({ activity }: { activity: Activity[] }) {
  return (
    <section className="card">
      <h2 className="pixel-title text-[15px]">Keeper activity</h2>
      {activity.length === 0 ? (
        <p className="text-sm text-ink-soft mt-2">Nothing yet. Deposit and the keeper buys within a few seconds.</p>
      ) : (
        <ul className="mt-2 grid gap-1.5">
          {activity.slice(0, 14).map((a) => (
            <li key={`${a.tx}-${a.text}`} className="flex flex-wrap gap-x-3 text-sm border-b border-line pb-1.5">
              <span className="text-[11px] text-ink-soft tabular-nums w-24">block {a.block.toString()}</span>
              <span className="text-ink">{a.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Deposit({ cfg, client, deskId, busy, run, write }: {
  cfg: LabConfig; client: PublicClient; deskId: bigint; busy: boolean; run: Run; write: Write;
}) {
  const [cur, setCur] = useState<"USDG" | "ETH" | "COAT">("USDG");
  const [amount, setAmount] = useState("");
  const decimals = cur === "USDG" ? 6 : 18;
  const go = () => {
    let raw: bigint;
    try {
      raw = parseUnits(amount || "0", decimals);
    } catch {
      return;
    }
    if (raw === 0n) return;
    if (cur === "USDG") {
      return run(`Deposit ${amount} USDG`, [
        () => write({ address: cfg.usdg, abi: erc20Abi, functionName: "approve", args: [cfg.depositRouter, raw] }),
        () => write({ address: cfg.depositRouter, abi: depositRouterAbi, functionName: "depositUsdg", args: [deskId, raw] }),
      ]);
    }
    if (cur === "ETH") {
      return run(`Deposit ${amount} ETH`, [
        () => write({ address: cfg.depositRouter, abi: depositRouterAbi, functionName: "depositEth", args: [deskId, 0n], value: raw }),
      ]);
    }
    return run(`Deposit ${amount} COAT`, [
      () => write({ address: cfg.coat, abi: erc20Abi, functionName: "approve", args: [cfg.depositRouter, raw] }),
      async () => {
        // the testnet COAT pool is thin: the lab takes whatever it pays (the site would quote a floor)
        await client.readContract({ address: cfg.coatRouter, abi: coatRouterAbi, functionName: "quoteSell", args: [raw] });
        return write({ address: cfg.depositRouter, abi: depositRouterAbi, functionName: "depositCoat", args: [deskId, raw, 1n, 0n] });
      },
    ]);
  };
  return (
    <section className="card">
      <h2 className="pixel-title text-[15px]">Deposit</h2>
      <div className="flex gap-2 mt-3" role="radiogroup" aria-label="Currency">
        {(["USDG", "ETH", "COAT"] as const).map((c) => (
          <button key={c} type="button" role="radio" aria-checked={cur === c}
            className={`btn ${cur === c ? "btn-accent" : "btn-ghost"}`} onClick={() => setCur(c)}>{c}</button>
        ))}
      </div>
      <label className="label mt-3 block" htmlFor="lab-dep">Amount</label>
      <input id="lab-dep" className="fld w-full mt-1" inputMode="decimal" placeholder={cur === "USDG" ? "500" : cur === "ETH" ? "0.1" : "10000"}
        value={amount} onChange={(e) => setAmount(e.target.value)} />
      <p className="text-xs text-ink-soft mt-2">
        {cur === "USDG" ? "Lands in the Desk wallet as is." : cur === "ETH"
          ? "Swapped to USDG at the WETH/USDG pool, floored by the ETH/USD feed."
          : "Sold for ETH on the COAT pool (the hook's skim funds the Booster), then swapped to USDG."}
      </p>
      <button type="button" className="btn btn-accent mt-3" disabled={busy || !amount} onClick={go}>Deposit {cur}</button>
    </section>
  );
}

function Withdraw({ cfg, desk, me, busy, run, write }: {
  cfg: LabConfig; desk: NonNullable<LabState["desk"]>; me: Address; busy: boolean; run: Run; write: Write;
}) {
  const options = [
    { token: cfg.usdg, symbol: "USDG", amount: desk.idle, decimals: 6 },
    ...desk.holdings.filter((h) => h.amount > 0n).map((h) => ({ token: h.token, symbol: h.symbol, amount: h.amount, decimals: 18 })),
  ];
  const [pick, setPick] = useState(0);
  const [amount, setAmount] = useState("");
  const o = options[Math.min(pick, options.length - 1)];
  const go = () => {
    let raw: bigint;
    try {
      raw = parseUnits(amount || "0", o.decimals);
    } catch {
      return;
    }
    if (raw === 0n) return;
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [me, raw] });
    return run(`Withdraw ${amount} ${o.symbol}`, [
      () => write({ address: desk.account, abi: deskAccountAbi, functionName: "execute", args: [o.token, 0n, data, 0] }),
    ]);
  };
  return (
    <section className="card">
      <h2 className="pixel-title text-[15px]">Withdraw</h2>
      <label className="label mt-3 block" htmlFor="lab-wd-token">From the Desk wallet</label>
      <select id="lab-wd-token" className="fld w-full mt-1" value={pick} onChange={(e) => setPick(Number(e.target.value))}>
        {options.map((x, i) => (
          <option key={x.token} value={i}>{x.symbol} · {num(x.amount, x.decimals, x.decimals === 6 ? 2 : 4)}</option>
        ))}
      </select>
      <div className="flex gap-2 mt-2">
        <input className="fld flex-1" inputMode="decimal" aria-label="Amount to withdraw" placeholder="Amount"
          value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button type="button" className="btn btn-ghost" onClick={() => setAmount(formatUnits(o.amount, o.decimals))}>Max</button>
      </div>
      <button type="button" className="btn btn-accent mt-3" disabled={busy || !amount} onClick={go}>Withdraw to my wallet</button>
    </section>
  );
}

function Sell({ cfg, deskId, me, busy, run, write }: { cfg: LabConfig; deskId: bigint; me: Address; busy: boolean; run: Run; write: Write }) {
  const [to, setTo] = useState("");
  const valid = /^0x[0-9a-fA-F]{40}$/.test(to);
  return (
    <section className="card">
      <h2 className="pixel-title text-[15px]">Hand over the Desk</h2>
      <p className="text-xs text-ink-soft mt-2">A sale in miniature: the Desk and everything in its wallet move to the new owner.</p>
      <input className="fld w-full mt-3" aria-label="New owner address" placeholder="0x… new owner" value={to}
        onChange={(e) => setTo(e.target.value.trim())} />
      <button type="button" className="btn btn-ghost mt-3" disabled={busy || !valid}
        onClick={() => run(`Transfer Desk #${deskId}`, [
          () => write({ address: cfg.desks, abi: deskNftAbi, functionName: "transferFrom", args: [me, to as Address, deskId] }),
        ])}>
        Transfer Desk #{deskId.toString()}
      </button>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="text-[11px] text-ink-soft uppercase tracking-widest">{label}</div>
      <div className="font-pixel text-[13px] text-ink-strong mt-1 tabular-nums">{value}</div>
    </div>
  );
}

function num(v: bigint, decimals: number, precision: number): string {
  const n = Number(formatUnits(v, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: precision, minimumFractionDigits: precision > 2 ? 0 : precision });
}
