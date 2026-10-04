"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { WagmiProvider, createConfig, useConnect, type CreateConnectorFn } from "wagmi";
import { injected, mock } from "wagmi/connectors";
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, type PublicClient } from "viem";
import { Header } from "@/components/Header";
import { StatusLine, type StatusKind } from "@/components/ui/Status";
import { erc20Abi } from "@/components/desk/abi";
import type { LabConfig, LabState } from "@/components/desk/data";
import { DeskApp, Figure, agoLabel, num, type DeskCtx } from "@/components/desk/DeskApp";

// Desk lab: a working surface for the Desk contracts. By default it talks to the local anvil
// fork started by desk/script/local_env.py (a "local test wallet" anvil impersonates, a faucet).
// With ?net=testnet it talks to the real Robinhood Chain testnet deployment instead: browser
// wallet only, and the faucet mints test USDG from the connected wallet (the deployer owns it).
// With ?view=site it shows the site's Desk tab instead of the lab strip, on the same chain and
// wallet, which is how the tab is previewed before mainnet addresses exist.

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

type Faucet = ReturnType<typeof makeLab>["faucet"];

function Lab({ cfg, client, faucet }: { cfg: LabConfig; client: PublicClient; faucet: Faucet }) {
  const { connectors, connect } = useConnect();
  const [siteView, setSiteView] = useState(false);

  // wagmi's reconnect is guarded by a module-level flag that the site's own wallet provider
  // already holds on load, so the lab's nested provider never gets to reconnect. Restore the
  // test wallet session ourselves when it was the last wallet used. The short delay lets the
  // provider's own hydrate effect (a parent, so it runs after this one) restore its stored
  // state first; connecting before it would be overwritten by that empty stored state.
  useEffect(() => {
    setSiteView(new URLSearchParams(window.location.search).get("view") === "site");
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

  const topUp = ({ me, run, write }: DeskCtx) =>
    me &&
    (cfg.mode === "testnet"
      // real testnet: no impersonation; test USDG is minted by its owner (the deployer's wallet)
      ? run("Mint 2,000 test USDG", [
        () => write({ address: cfg.usdg, abi: erc20Abi, functionName: "mint", args: [me, 2_000n * E6] }),
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

  if (siteView) return <DeskApp cfg={cfg} client={client} variant="site" pollMs={POLL_MS} />;
  return (
    <DeskApp cfg={cfg} client={client} variant="lab" pollMs={POLL_MS}
      top={(ctx) => (
        <LabHeader cfg={cfg} s={ctx.s} now={ctx.now} connected={ctx.connected} busy={ctx.busy}
          onTopUp={() => topUp(ctx)} status={ctx.status} />
      )} />
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
