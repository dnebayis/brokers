import { ACTIVE_NETWORK } from "./chains";
import type { Address } from "viem";
import deployments from "../../deployments.json";

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
  router: Address | ""; // CoatRouter (COAT<->ETH periphery; trading UI lives in the Floor tab)
  buybackBurner: Address;
  poolId: `0x${string}`;
  // Ownerless periphery that claims any number of Brokers in one tx (claimBatch caps at 5).
  // Optional: absent (testnet) the UI falls back to chunked claimBatch calls.
  claimSweeper?: Address;
  // Gift vault: donated NFTs drawn on chain to random active Brokers. Optional: absent, the
  // gift panels stay hidden.
  giftVault?: Address;
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

// Every public door in one place: the same links render in the header, the side panel
// and the footer, so a URL change is one edit.
export const LINKS = {
  opensea: OPENSEA_URL,
  coatOnOpenSea: `https://opensea.io/token/robinhood/${ADDR.coat.toLowerCase()}?timeframe=seven_days`,
  x: "https://x.com/CoattailBrokers",
  discord: "https://discord.gg/kTjj2V9r2D",
} as const;

// $COAT paid out to Broker holders from the treasury, one entry per tranche. Each drop is
// a plain ERC-20 transfer per Broker wallet, so it is not visible through any contract
// getter; the receipts file in the repo carries every tx hash. Valued at today's $COAT
// price on the site, the same way stock is valued at today's feeds.
export const COAT_DROPS: { label: string; block: number; coat: number; recipients: number; receipts: string }[] = [
  {
    label: "tranche 1 · active Brokers",
    block: 52561613,
    coat: 14_000_000,
    recipients: 1175,
    receipts: "https://github.com/dnebayis/brokers/blob/main/indexer/reports/coat-bonus-t1.sent.csv",
  },
  {
    label: "tranche 2 · inactive Brokers",
    block: 53682930,
    coat: 6_755_744.680851064,
    recipients: 567,
    receipts: "https://github.com/dnebayis/brokers/blob/main/indexer/reports/coat-bonus-t2.sent.csv",
  },
];
export const COAT_DROPPED_TOTAL = COAT_DROPS.reduce((a, d) => a + d.coat, 0);

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
  { name: "GiftVault", key: "giftVault" },
  { name: "Permanent LP Locker", key: "lpLocker" },
  { name: "Buyback Burner", key: "buybackBurner" },
];
