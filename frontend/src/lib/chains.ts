import { defineChain } from "viem";

// A configured provider is primary; the official rate-limited endpoint is read fallback.
// There are deliberately no demo credentials in production bundles.
const ALCHEMY_TESTNET = process.env.NEXT_PUBLIC_RPC_URL_TESTNET;
const ALCHEMY_MAINNET = process.env.NEXT_PUBLIC_RPC_URL_MAINNET;
const PUBLIC_TESTNET = "https://rpc.testnet.chain.robinhood.com";
const PUBLIC_MAINNET = "https://rpc.mainnet.chain.robinhood.com";

// Canonical Multicall3 — present on RH Chain (verified). Lets wagmi batch many reads into ONE
// RPC call, the single biggest lever for serving 500–1000 concurrent users without rate limits.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

// Robinhood Chain — Arbitrum Orbit L2s. Native gas token is ETH.
export const rhTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [...(ALCHEMY_TESTNET ? [ALCHEMY_TESTNET] : []), PUBLIC_TESTNET] } },
  contracts: { multicall3: { address: MULTICALL3 } },
  testnet: true,
});

export const rhMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [...(ALCHEMY_MAINNET ? [ALCHEMY_MAINNET] : []), PUBLIC_MAINNET] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

export const ACTIVE_NETWORK =
  (process.env.NEXT_PUBLIC_NETWORK as "testnet" | "mainnet") ?? "testnet";

export const activeChain = ACTIVE_NETWORK === "mainnet" ? rhMainnet : rhTestnet;

// Canonical Blockscout explorer for the active chain. robinhoodchain.blockscout.com is the
// official mainnet instance; rh-scan.com is a lookalike scam and must never be linked.
export const EXPLORER_BASE =
  ACTIVE_NETWORK === "mainnet"
    ? "https://robinhoodchain.blockscout.com"
    : "https://robinhoodchain-testnet.blockscout.com";

export const explorerTx = (hash: string) => `${EXPLORER_BASE}/tx/${hash}`;
export const explorerAddress = (addr: string) => `${EXPLORER_BASE}/address/${addr}`;

// Ordered RPC list for the active chain (primary first, fallbacks after).
export const RPC_HTTP = activeChain.rpcUrls.default.http;

// Alchemy NFT API base (v3) for the active chain — used to enumerate a wallet's Brokers
// cheaply (one request) instead of scanning Transfer logs.
export const ALCHEMY_NFT_BASE =
  ACTIVE_NETWORK === "mainnet"
    ? process.env.NEXT_PUBLIC_ALCHEMY_NFT_BASE_MAINNET
    : process.env.NEXT_PUBLIC_ALCHEMY_NFT_BASE_TESTNET;
export const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY ?? "";
