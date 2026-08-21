import { ACTIVE_NETWORK } from "./chains";
import type { Address } from "viem";
import deployments from "../../deployments.json";

// Swap tab hidden — COAT trading happens off-site for now. Flip to true to restore the in-app swap.
export const SWAP_ENABLED = false;

// Deployment manifests are deliberately zeroed until the clean release deployment passes.
type AddrSet = {
  broker: Address;
  coat: Address;
  strategyRegistry: Address;
  erc6551Registry: Address;
  booster: Address;
  feeSplitter: Address;
  renderer: Address;
  accountImpl: Address;
  stockRouter: Address;
  lpLocker: Address;
  feeHook: Address;
  router: Address | ""; // permanent swap router — deploy + paste to enable the Swap tab
  buybackBurner: Address;
  poolId: `0x${string}`;
  // Ownerless periphery that claims any number of Brokers in one tx (claimBatch caps at 5).
  // Optional: absent (testnet) the UI falls back to chunked claimBatch calls.
  claimSweeper?: Address;
};

const TESTNET = deployments.testnet as AddrSet;

const MAINNET = deployments.mainnet as AddrSet;

export const ADDR: AddrSet = ACTIVE_NETWORK === "mainnet" ? MAINNET : TESTNET;

// Ownership discovery starts at the known deployment block, never at genesis. This makes the
// Transfer-log path a small, deterministic request even if an NFT indexing API is unavailable.
export const BROKER_DEPLOYMENT_BLOCK = ACTIVE_NETWORK === "testnet" ? 0x60cdc73n : 39460869n;

// Primary mint is closed (1,776/1,776). Brokers are only obtainable on the secondary
// market, so every "get a Broker" call to action points here.
export const OPENSEA_URL = "https://opensea.io/collection/coattailbrokers";

export const PARAMS = {
  activationBurn: 36_750,
  maxSupply: 1776,
  split: { booster: 80, project: 10, buyback: 10 },
  hookFeeBps: 100,
};

export const CONTRACTS_FOR_DOCS: { name: string; key: keyof AddrSet }[] = [
  { name: "CoattailBroker", key: "broker" },
  { name: "$COAT", key: "coat" },
  { name: "CoatFeeHook", key: "feeHook" },
  { name: "Booster", key: "booster" },
  { name: "FeeSplitter", key: "feeSplitter" },
  { name: "StrategyRegistry", key: "strategyRegistry" },
  { name: "ERC-6551 Registry", key: "erc6551Registry" },
  { name: "BrokerRenderer", key: "renderer" },
  { name: "BrokerAccount (6551)", key: "accountImpl" },
  { name: "StockRouter", key: "stockRouter" },
  { name: "ClaimSweeper", key: "claimSweeper" },
  { name: "Permanent LP Locker", key: "lpLocker" },
  { name: "Buyback Burner", key: "buybackBurner" },
];
