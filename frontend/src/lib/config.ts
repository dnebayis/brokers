import { ACTIVE_NETWORK } from "./chains";
import type { Address } from "viem";
import deployments from "../../deployments.json";

// Deployment manifests are deliberately zeroed until the clean release deployment passes.
type AddrSet = {
  broker: Address;
  coat: Address;
  registry: Address;
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
};

const TESTNET = deployments.testnet as AddrSet;

const MAINNET = deployments.mainnet as AddrSet;

export const ADDR: AddrSet = ACTIVE_NETWORK === "mainnet" ? MAINNET : TESTNET;

export const PARAMS = {
  mintPriceEth: "0.0015",
  activationBurn: 36_750,
  maxSupply: 1776,
  walletCap: 2,
  split: { booster: 80, project: 10, buyback: 10 },
  hookFeeBps: 100,
};

export const CONTRACTS_FOR_DOCS: { name: string; key: keyof AddrSet }[] = [
  { name: "CoattailBroker", key: "broker" },
  { name: "$COAT", key: "coat" },
  { name: "CoatFeeHook", key: "feeHook" },
  { name: "Booster", key: "booster" },
  { name: "FeeSplitter", key: "feeSplitter" },
  { name: "StrategyRegistry", key: "registry" },
  { name: "BrokerRenderer", key: "renderer" },
  { name: "BrokerAccount (6551)", key: "accountImpl" },
  { name: "StockRouter", key: "stockRouter" },
  { name: "Permanent LP Locker", key: "lpLocker" },
  { name: "Buyback Burner", key: "buybackBurner" },
];
