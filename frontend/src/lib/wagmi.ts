import { cookieStorage, createConfig, createStorage } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { fallback, http } from "viem";
import { ACTIVE_NETWORK, rhMainnet, rhTestnet, RPC_PUBLIC_FIRST } from "./chains";

// WalletConnect project id (free from cloud.walletconnect.com). A fallback keeps
// injected wallets (MetaMask) working even before you set the env var.
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

// http() with `batch` coalesces many eth_calls into ONE HTTP request; combined with
// multicall (below) and React-Query caching, per-user RPC load drops ~10x. Reads default
// to the free official endpoint (CORS *, verified) and spill onto the metered provider
// only on failure; transaction WRITES never touch this transport — they go through the
// connected wallet's own provider.
const transport = fallback(RPC_PUBLIC_FIRST.map((url) => http(url, { batch: { wait: 16 } })));
const storage = createStorage({
  key: "coattail.wallet",
  storage: cookieStorage,
});

const shared = {
  connectors: [
    injected(),
    ...(projectId && typeof window !== "undefined" ? [walletConnect({ projectId, metadata: {
      name: "Coattail Brokers",
      description: "Mirror Congress. Own the basket.",
      url: typeof window === "undefined" ? "https://coattail.example" : window.location.origin,
      icons: [],
    } })] : []),
  ],
  batch: { multicall: true }, // fold contract reads through Multicall3
  pollingInterval: 12_000,
  storage,
  ssr: true,
} as const;

export const wagmiConfig = ACTIVE_NETWORK === "mainnet"
  ? createConfig({ ...shared, chains: [rhMainnet], transports: { [rhMainnet.id]: transport } })
  : createConfig({ ...shared, chains: [rhTestnet], transports: { [rhTestnet.id]: transport } });
