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

// Desk lab: a working surface for the Desk contracts. By default it talks to the local anvil
// fork started by desk/script/local_env.py (a "local test wallet" anvil impersonates, a faucet).
// With ?net=testnet it talks to the real Robinhood Chain testnet deployment instead: browser
// wallet only, and the faucet mints test USDG from the connected wallet (the deployer owns it).

const E6 = 1_000_000n;
const POLL_MS = 3_000;
const TEST_WALLET_ID = "lab-test-wallet";

export function DeskLabRoot() {
  const [cfg, setCfg] = useState<LabConfig | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const net = new URLSearchParams(window.location.search).get("net");
    fetch(net === "testnet" ? "/desk-testnet.json" : "/desk-local.json", { cache: "no-store" })
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
      <main className="w-full max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 flex-1 py-8 lg:py-12">{children}</main>
    </div>
  );
}

function makeLab(cfg: LabConfig) {
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.mode === "testnet" ? "Robinhood Chain Testnet" : "Desk lab (local fork)",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } },
    testnet: true,
  });
  const connectors: CreateConnectorFn[] = [injected()];
  if (cfg.mode !== "testnet" && cfg.testWallet) {
    const base = mock({ accounts: [cfg.testWallet], features: { reconnect: true } });
    connectors.unshift((config) => ({ ...base(config), id: TEST_WALLET_ID, name: "Local test wallet" }));
  }
  const wagmi = createConfig({
    chains: [chain],
    connectors,
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
    (cfg.mode === "testnet"
      // real testnet: no impersonation; test USDG is minted by its owner (the deployer's wallet)
      ? run("Mint 2,000 test USDG", [
        () => writeContractAsync({ address: cfg.usdg, abi: erc20Abi, functionName: "mint", args: [me, 2_000n * E6] }),
      ])
      : run("Top up", [
      async () => {
        await (client.request as (a: { method: string; params: unknown[] }) => Promise<unknown>)({
          method: "anvil_setBalance",
          params: [me, "0x8ac7230489e80000"], // 10 ETH
        });
        return faucet.writeContract({ address: cfg.coat, abi: erc20Abi, functionName: "transfer", args: [me, parseUnits("200000", 18)], chain: null });
      },
      () => faucet.writeContract({ address: cfg.usdg, abi: erc20Abi, functionName: "mint", args: [me, 2_000n * E6], chain: null }),
    ]));

  const mintDesk = () =>
    s &&
    run("Mint a Desk", [
      () => writeContractAsync({ address: cfg.coat, abi: erc20Abi, functionName: "approve", args: [cfg.desks, s.mintPrice] }),
      () => writeContractAsync({ address: cfg.desks, abi: deskNftAbi, functionName: "mint" }),
    ]);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-12">
      <LabHeader cfg={cfg} s={s} now={now} connected={isConnected} busy={busy} onTopUp={topUp} status={status} />

      {!isConnected ? (
        cfg.mode === "testnet" ? (
          <p className="max-w-2xl text-base text-ink leading-relaxed">
            The Desk contracts on Robinhood Chain testnet. Connect a browser wallet on chain {cfg.chainId}, then mint, deposit,
            withdraw and hand a Desk over as a user would; every step is a real testnet transaction. The keeper buys and
            rebalances in the background. Test USDG is minted by the deployer&rsquo;s wallet.
          </p>
        ) : (
          <p className="max-w-2xl text-base text-ink leading-relaxed">
            The Desk contracts on a local copy of testnet. Connect with <b className="text-ink-strong">Local test wallet</b> in the
            header (already funded), then mint, deposit, withdraw and hand a Desk over as a user would. The keeper buys and
            rebalances in the background. Nothing here touches a real network.
          </p>
        )
      ) : (
        <>
          <DeskTabs owned={s?.owned ?? []} selected={desk?.id} mintPrice={s?.mintPrice} busy={busy}
            onSelect={setSelected} onMint={mintDesk} />
          {desk && me ? (
            <>
              <Hero desk={desk} busy={busy} run={run} write={writeContractAsync} />
              <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-12 lg:gap-6">
                <div className="lg:col-span-8 grid grid-cols-[minmax(0,1fr)] gap-12 content-start">
                  <Holdings desk={desk} />
                  <Timeline activity={(s?.activity ?? []).filter((a) => a.deskId === undefined || a.deskId === desk.id)}
                    now={now} deskId={desk.id} />
                </div>
                <aside className="order-first lg:order-none lg:col-span-4 grid grid-cols-[minmax(0,1fr)] gap-12 content-start">
                  <Actions cfg={cfg} client={client} desk={desk} me={me} ethUsd={s?.ethUsd ?? 0} busy={busy} run={run}
                    write={writeContractAsync} />
                  <Basket s={s} />
                </aside>
              </div>
            </>
          ) : (
            <p className="max-w-2xl text-base text-ink leading-relaxed">
              No Desk yet. Mint one from the row above: the COAT price goes to the bonus pool for active Brokers and nothing
              is burned. The Desk comes with its own wallet, which the engine buys into.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// --- layout primitives ---------------------------------------------------------------------
// Structure follows the Coinbase DESIGN.md (awesome-design-md): most surfaces flat, sections
// separated by hairlines and small-caps labels, a single elevated object per view (the action
// panel), 4px spacing base, 24px between blocks and 48px between sections, 12-column body.
// Colors, type and square corners stay Coattail's.

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 pb-3 border-b border-line">
      <h2 className="font-pixel text-[13px] text-ink-strong tracking-wide">{children}</h2>
      {aside ? <div className="text-xs text-ink-soft">{aside}</div> : null}
    </div>
  );
}

function Figure({ label, value, toneValue, big = false }: { label: string; value: string; toneValue?: number; big?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-widest text-ink-soft">{label}</div>
      <div className={`font-pixel tabular-nums mt-1.5 ${big ? "text-xl" : "text-[15px]"} ${toneValue === undefined ? "text-ink-strong" : tone(toneValue)}`}>
        {value}
      </div>
    </div>
  );
}

// --- page header -----------------------------------------------------------------------------

function LabHeader({ cfg, s, now, connected, busy, onTopUp, status }: {
  cfg: LabConfig; s?: LabState; now: number; connected: boolean; busy: boolean; onTopUp: () => void;
  status: { msg: string; kind: StatusKind };
}) {
  const ago = s?.keeperLastAt && now ? agoLabel(now - s.keeperLastAt) : null;
  return (
    <header className="grid gap-4 pb-6 border-b border-line">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <span className="chip">{cfg.mode === "testnet" ? "Robinhood Chain testnet" : "Local fork · not a real network"}</span>
          <h1 className="font-pixel text-2xl text-ink-strong mt-3">Desk lab</h1>
          <p className="text-sm text-ink-soft mt-1.5 inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="tabular-nums">chain {cfg.chainId} · block {s ? s.block.toLocaleString("en-US") : "…"}</span>
            <span className="inline-flex items-center gap-1.5">
              <span className={`inline-block w-2 h-2 ${ago ? "bg-good" : "bg-ink-soft"}`} aria-hidden="true" />
              keeper {ago ? `last moved ${ago}` : "waiting for a deposit"}
            </span>
          </p>
        </div>
        {connected && s && (
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <Figure label="ETH" value={num(s.eth, 18, 3)} />
            <Figure label="COAT" value={num(s.coat, 18, 0)} />
            <Figure label="Test USDG" value={num(s.usdg, 6, 2)} />
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onTopUp}>
              {cfg.mode === "testnet" ? "Mint test USDG" : "Top up"}
            </button>
          </div>
        )}
      </div>
      {status.msg && <StatusLine msg={status.msg} kind={status.kind} />}
    </header>
  );
}

// --- desk tabs -------------------------------------------------------------------------------

function DeskTabs({ owned, selected, mintPrice, busy, onSelect, onMint }: {
  owned: { id: bigint; image: string }[]; selected?: bigint; mintPrice?: bigint; busy: boolean;
  onSelect: (id: bigint) => void; onMint: () => void;
}) {
  return (
    <nav className="-mt-6 flex items-stretch gap-6 overflow-x-auto border-b border-line" role="tablist" aria-label="Your desks">
      {owned.map((d) => {
        const on = d.id === selected;
        return (
          <button key={d.id.toString()} type="button" role="tab" aria-selected={on} onClick={() => onSelect(d.id)}
            className={`shrink-0 flex items-center gap-3 pb-3 -mb-px border-b-2 ${on ? "border-accent" : "border-transparent opacity-70 hover:opacity-100"}`}>
            {d.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={d.image} alt="" width={40} height={40} className="block [image-rendering:pixelated] border border-line" />
            ) : <span className="w-10 h-10 border border-line" />}
            <span className={`font-pixel text-[12px] ${on ? "text-ink-strong" : "text-ink"}`}>Desk #{d.id.toString()}</span>
          </button>
        );
      })}
      <button type="button" onClick={onMint} disabled={busy || mintPrice === undefined}
        className="shrink-0 ml-auto flex items-center gap-2 pb-3 text-left text-sm text-ink-soft hover:text-ink-strong disabled:opacity-50">
        <span className="font-pixel text-[12px] text-accent">+ Mint a Desk</span>
        <span className="tabular-nums">{mintPrice !== undefined ? `${num(mintPrice, 18, 0)} COAT` : ""}</span>
      </button>
    </nav>
  );
}

// --- hero: the NFT and the balance -----------------------------------------------------------

function Hero({ desk, busy, run, write }: { desk: DeskView; busy: boolean; run: Run; write: Write }) {
  const L = desk.ledger;
  const capPct = desk.cap > 0n ? Math.min(100, Number((desk.principal * 1000n) / desk.cap) / 10) : 0;
  const unbooked = desk.idle > desk.investable ? desk.idle - desk.investable : 0n;
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-12 lg:gap-6 items-center">
      <div className="lg:col-span-5">
        {desk.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={desk.image} alt={`Desk #${desk.id} artwork`} width={480} height={480}
            className="block w-full max-w-[480px] aspect-square [image-rendering:pixelated] border-2 border-ink shadow-pixel" />
        ) : <div className="w-full max-w-[480px] aspect-square border-2 border-ink" />}
      </div>
      <div className="lg:col-span-7 lg:pl-6 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-pixel text-[13px] text-ink-strong">
            Desk #{desk.id.toString()} <span className="font-sans text-xs text-ink-soft ml-2">wallet {short(desk.account)}</span>
          </span>
          <button type="button" disabled={busy}
            onClick={() => run(desk.paused ? "Turn the engine on" : "Pause the engine", [
              () => write({ address: desk.account, abi: deskAccountAbi, functionName: "setEnginePaused", args: [!desk.paused] }),
            ])}
            className="inline-flex items-center gap-2 text-xs text-ink-soft hover:text-ink-strong"
            aria-pressed={!desk.paused} title={desk.paused ? "The keeper cannot touch this Desk" : "The keeper may trade this Desk"}>
            <span className={`inline-block w-2 h-2 ${desk.paused ? "bg-ink-soft" : "bg-good"}`} aria-hidden="true" />
            <span className="text-ink-strong">{desk.paused ? "Engine paused" : "Engine on"}</span>
            <span className="underline">{desk.paused ? "turn on" : "pause"}</span>
          </button>
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-2 mt-4 pb-5 border-b border-line">
          {desk.traits.map((t) => (
            <div key={t.name}>
              <dt className="text-[10px] uppercase tracking-widest text-ink-soft">{t.name}</dt>
              <dd className="text-sm text-ink-strong">{t.value}</dd>
            </div>
          ))}
        </dl>
        <div className="text-[11px] uppercase tracking-widest text-ink-soft mt-6">Value now</div>
        <div className="font-pixel text-4xl sm:text-5xl text-ink-strong tabular-nums mt-2">{usd(desk.totalUsd)}</div>
        <div className={`font-pixel text-lg tabular-nums mt-3 ${tone(L.pnl)}`}>
          {signed(L.pnl)} <span className="text-sm">({signedPct(L.pnlPct)})</span>
          <span className="font-sans text-xs text-ink-soft ml-3">all time</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 mt-8 border-t border-line">
          {[
            { label: "Put in", value: usd(L.deposited) },
            { label: "Taken out", value: usd(L.withdrawn) },
            { label: "Realized", value: signed(L.realized), toneValue: L.realized },
            { label: "Fees paid", value: usd(L.fees) },
          ].map((f, i) => (
            <div key={f.label} className={`pt-4 pb-1 ${i > 0 ? "sm:pl-5 sm:border-l border-line" : ""} ${i % 2 === 1 ? "pl-5 border-l border-line sm:pl-5" : ""}`}>
              <Figure label={f.label} value={f.value} toneValue={f.toneValue} />
            </div>
          ))}
        </div>

        <div className="mt-8">
          <div className="flex justify-between text-[11px] uppercase tracking-widest text-ink-soft">
            <span>Pilot cap · money put in</span>
            <span className="tabular-nums normal-case tracking-normal text-ink">
              {usd(Number(desk.principal) / 1e6)} of {usd(Number(desk.cap) / 1e6, 0)}
            </span>
          </div>
          <div className="h-1.5 bg-line mt-2" aria-hidden="true">
            <div className="h-full bg-accent" style={{ width: `${capPct}%` }} />
          </div>
          <p className="text-xs text-ink-soft mt-2 leading-relaxed">
            You can add {usd(Number(desk.room) / 1e6)} more. Profit and loss never count toward the cap, and taking money
            out frees room by what it is worth when it leaves.
            {unbooked > 0n ? ` ${usd(Number(unbooked) / 1e6)} in the wallet was sent around the deposit router, so the engine leaves it alone.` : ""}
          </p>
        </div>
      </div>
    </section>
  );
}

// --- holdings: asset rows ------------------------------------------------------------------

function Holdings({ desk }: { desk: DeskView }) {
  return (
    <section>
      <SectionTitle aside={`${desk.holdings.length} names`}>Holdings</SectionTitle>
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums min-w-[560px]">
          <thead>
            <tr className="text-[11px] text-ink-soft uppercase tracking-widest text-left">
              <th className="py-3 font-normal">Asset</th>
              <th className="py-3 font-normal">Weight now · target</th>
              <th className="py-3 font-normal text-right">Value</th>
              <th className="py-3 font-normal text-right">Cost</th>
              <th className="py-3 font-normal text-right">P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {desk.holdings.map((h) => (
              <tr key={h.token} className="border-t border-line">
                <td className="py-4 pr-4">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 shrink-0 grid place-items-center bg-cream-2 border border-line font-pixel text-[10px] text-ink-strong">
                      {h.symbol.replace(/^t/, "").slice(0, 2)}
                    </span>
                    <div>
                      <div className="text-ink-strong font-medium">{h.symbol}</div>
                      <div className="text-xs text-ink-soft">{num(h.amount, 18, 4)} · {usd(h.price)}</div>
                    </div>
                  </div>
                </td>
                <td className="py-4 pr-6 w-[34%]"><WeightBar now={h.weightNow} target={h.target} /></td>
                <td className="py-4 text-right text-ink-strong">{usd(h.usd)}</td>
                <td className="py-4 text-right text-ink-soft">{h.amount > 0n ? usd(h.cost) : "–"}</td>
                <td className={`py-4 text-right ${tone(h.pnl)}`}>
                  {h.amount > 0n && h.cost > 0 ? (
                    <>
                      <div>{signed(h.pnl)}</div>
                      <div className="text-xs">{signedPct((h.pnl / h.cost) * 100)}</div>
                    </>
                  ) : <span className="text-ink-soft">–</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WeightBar({ now, target }: { now: number; target: number }) {
  return (
    <div>
      <div className="relative h-1.5 bg-line" aria-hidden="true">
        <div className="absolute inset-y-0 left-0 bg-ink-strong" style={{ width: `${Math.min(100, now)}%` }} />
        {target > 0 && <div className="absolute -top-1.5 -bottom-1.5 w-0.5 bg-accent" style={{ left: `calc(${target}% - 1px)` }} />}
      </div>
      <div className="flex justify-between text-xs mt-2">
        <span className="text-ink-strong">{now.toFixed(1)}%</span>
        <span className="text-accent">{target}%</span>
      </div>
    </div>
  );
}

// --- actions: the one elevated object ---------------------------------------------------------

type Tab = "deposit" | "withdraw" | "handover";

function Actions(props: {
  cfg: LabConfig; client: PublicClient; desk: DeskView; me: Address; ethUsd: number; busy: boolean; run: Run; write: Write;
}) {
  const [tab, setTab] = useState<Tab>("deposit");
  const tabs: [Tab, string][] = [["deposit", "Deposit"], ["withdraw", "Withdraw"], ["handover", "Hand over"]];
  return (
    <section className="border-2 border-ink bg-cream-2 shadow-pixel">
      <div className="grid grid-cols-3 border-b-2 border-ink" role="tablist" aria-label="Desk actions">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`font-pixel text-[11px] py-3.5 border-r-2 last:border-r-0 border-ink ${tab === k
              ? "bg-ink text-cream" : "text-ink-strong hover:bg-cream"}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="p-6">
        {tab === "deposit" && <Deposit {...props} />}
        {tab === "withdraw" && <Withdraw {...props} />}
        {tab === "handover" && <HandOver {...props} />}
      </div>
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

  const roomUsd = Number(desk.room) / 1e6;
  const overRoom = raw > 0n && estimate !== null && estimate > roomUsd + 1e-9;
  const go = () => {
    if (raw === 0n || overRoom) return;
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
    <div className="grid gap-5">
      <div className="grid grid-cols-3 border border-line" role="radiogroup" aria-label="Currency">
        {(["USDG", "ETH", "COAT"] as const).map((c) => (
          <button key={c} type="button" role="radio" aria-checked={cur === c} onClick={() => setCur(c)}
            className={`font-pixel text-[11px] py-2.5 border-r last:border-r-0 border-line ${cur === c ? "bg-accent text-white" : "text-ink-strong hover:bg-cream"}`}>
            {c}
          </button>
        ))}
      </div>
      <div>
        <label className="label" htmlFor="lab-dep">Amount in {cur}</label>
        <input id="lab-dep" className="fld tabular-nums" inputMode="decimal"
          placeholder={cur === "USDG" ? "500" : cur === "ETH" ? "0.1" : "10000"} value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div className="flex items-baseline justify-between text-xs -mt-2">
        <span className="text-ink-soft">Room under the pilot cap</span>
        <button type="button" className="underline text-ink-strong tabular-nums" disabled={cur !== "USDG"}
          onClick={() => setAmount((Math.floor(roomUsd * 100) / 100).toString())}>
          {usd(roomUsd)}
        </button>
      </div>
      <div className="flex items-baseline justify-between border-t border-line pt-4 text-sm">
        <span className="text-ink-soft">Lands in the Desk</span>
        <span className="font-pixel text-ink-strong tabular-nums">{raw > 0n && estimate !== null ? `≈ ${usd(estimate)}` : "–"}</span>
      </div>
      <p className="text-xs text-ink-soft -mt-2 leading-relaxed">
        {cur === "USDG" ? "Goes into the Desk wallet as is."
          : cur === "ETH" ? "Swapped to USDG at the WETH/USDG pool, floored by the ETH/USD feed."
            : "Sold for ETH on the COAT pool (its fee skim funds the Booster), then swapped to USDG. The testnet COAT pool is thin."}
      </p>
      {overRoom && (
        <p className="text-xs text-accent -mt-2">That is more than the {usd(roomUsd)} of room left; the deposit would be refused.</p>
      )}
      <button type="button" className="btn btn-accent w-full" disabled={busy || raw === 0n || overRoom} onClick={go}>Deposit {cur}</button>
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
    <div className="grid gap-5">
      <div>
        <span className="label">From the Desk wallet</span>
        <div className="border border-line" role="radiogroup" aria-label="Asset to withdraw">
          {options.map((x, i) => (
            <button key={x.token} type="button" role="radio" aria-checked={pick === i} onClick={() => { setPick(i); setAmount(""); }}
              className={`w-full flex items-center justify-between px-3 py-2.5 text-sm border-t first:border-t-0 border-line ${pick === i ? "bg-cream" : "hover:bg-cream"}`}>
              <span className="inline-flex items-center gap-2">
                <span className={`w-2 h-2 ${pick === i ? "bg-accent" : "bg-line"}`} aria-hidden="true" />
                <span className="text-ink-strong">{x.symbol}</span>
              </span>
              <span className="tabular-nums text-ink">{num(x.amount, x.decimals, x.decimals === 6 ? 2 : 4)} <span className="text-ink-soft">· {usd(x.usd)}</span></span>
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="label" htmlFor="lab-wd">Amount of {o.symbol}</label>
        <div className="flex gap-2">
          <input id="lab-wd" className="fld tabular-nums" inputMode="decimal" placeholder="0" value={amount}
            onChange={(e) => setAmount(e.target.value)} />
          <button type="button" className="btn btn-ghost" onClick={() => setAmount(formatUnits(o.amount, o.decimals))}>Max</button>
        </div>
      </div>
      <p className="text-xs text-ink-soft leading-relaxed">
        Only the Desk&rsquo;s owner can move assets out. Stock taken out frees the pilot cap and counts in profit and loss at
        that moment&rsquo;s price.
      </p>
      <button type="button" className="btn btn-accent w-full" disabled={busy || raw === 0n || raw > o.amount} onClick={go}>
        Withdraw to my wallet
      </button>
    </div>
  );
}

function HandOver({ cfg, desk, me, busy, run, write }: { cfg: LabConfig; desk: DeskView; me: Address; busy: boolean; run: Run; write: Write }) {
  const [to, setTo] = useState("");
  const valid = /^0x[0-9a-fA-F]{40}$/.test(to) && to.toLowerCase() !== me.toLowerCase();
  return (
    <div className="grid gap-5">
      <p className="text-sm text-ink leading-relaxed">
        A sale in miniature: Desk #{desk.id.toString()} and everything in its wallet ({usd(desk.totalUsd)} right now) move to the
        new owner. From then on only they can withdraw or pause the engine.
      </p>
      <div>
        <label className="label" htmlFor="lab-to">New owner</label>
        <input id="lab-to" className="fld font-mono text-sm" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} />
      </div>
      <button type="button" className="btn btn-ghost w-full" disabled={busy || !valid}
        onClick={() => run(`Hand over Desk #${desk.id}`, [
          () => write({ address: cfg.desks, abi: deskNftAbi, functionName: "transferFrom", args: [me, to as Address, desk.id] }),
        ])}>
        Transfer Desk #{desk.id.toString()}
      </button>
    </div>
  );
}

// --- basket, traits, keeper -----------------------------------------------------------------

function Basket({ s }: { s?: LabState }) {
  return (
    <section>
      <SectionTitle aside={`epoch ${s ? s.epoch.toString() : "…"}`}>Basket</SectionTitle>
      <ul>
        {(s?.basket ?? []).map((b) => (
          <li key={b.token} className="py-3 border-b border-line">
            <div className="flex justify-between text-sm">
              <span className="text-ink-strong">{b.symbol}</span>
              <span className="tabular-nums text-ink">{b.weight}% <span className="text-ink-soft">· {usd(b.price)}</span></span>
            </div>
            <div className="h-1.5 bg-line mt-2" aria-hidden="true">
              <div className="h-full bg-ink-strong" style={{ width: `${b.weight}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs text-ink-soft mt-3 leading-relaxed">
        Changed from the terminal. On a new epoch the keeper sells only what sits above its weight and buys what sits below.
      </p>
    </section>
  );
}

const KIND: Record<Activity["kind"], { label: string; cls: string }> = {
  buy: { label: "Buy", cls: "text-good" },
  sell: { label: "Sell", cls: "text-accent" },
  fees: { label: "Fees", cls: "text-ink-soft" },
};

function Timeline({ activity, now, deskId }: { activity: Activity[]; now: number; deskId: bigint }) {
  return (
    <section>
      <SectionTitle aside={`Desk #${deskId.toString()} and fee flushes`}>Keeper activity</SectionTitle>
      {activity.length === 0 ? (
        <p className="text-sm text-ink-soft py-4">Nothing yet. Deposit and the keeper buys within a few seconds.</p>
      ) : (
        <ol>
          {activity.slice(0, 14).map((a) => (
            <li key={`${a.tx}-${a.text}`} className="grid grid-cols-[48px_minmax(0,1fr)_auto_72px] items-baseline gap-4 py-3 border-b border-line text-sm">
              <span className={`font-pixel text-[10px] ${KIND[a.kind].cls}`}>{KIND[a.kind].label}</span>
              <span className="text-ink truncate">{a.text}</span>
              <span className="text-ink-strong tabular-nums text-right">{usd(a.usd)}</span>
              <span className="text-xs text-ink-soft tabular-nums text-right whitespace-nowrap" title={`block ${a.block} · ${a.tx}`}>
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
