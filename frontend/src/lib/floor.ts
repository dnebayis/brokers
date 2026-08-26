import type { Address } from "viem";
import { ACTIVE_NETWORK } from "./chains";

// Trade-terminal config. Deliberately dark until launch: this file ships in the public
// bundle, so the mainnet contract stays out of the repo until the launch commit flips
// `live` and pastes the address. The testnet address is the staging deployment used to
// exercise the full flow end to end.
export const FLOOR: {
  live: boolean;
  router: Address | "";
  usdg: Address | "";
  usdgDecimals: number;
  coat: Address | "";
  coatRouter: Address | "";
  booster: Address | "";
  stocks: { symbol: string; address: Address }[];
  presets: { id: number; name: string; blurb: string }[];
} = {
  live: false,
  router:
    ACTIVE_NETWORK === "testnet" ? "0x927E23B683AcBbeB7F2FbBFa035aF80acfE0b31a" : "",
  usdg: ACTIVE_NETWORK === "testnet" ? "0xca71484e6FA828dc261C7b4e902d3DF47542aDa4" : "",
  usdgDecimals: ACTIVE_NETWORK === "testnet" ? 18 : 6,
  coat: ACTIVE_NETWORK === "testnet" ? "0xD3f44c7DD32D12C7a6776C23c839DEcA8196cf07" : "",
  coatRouter: ACTIVE_NETWORK === "testnet" ? "0x5fBCa6b6Dd403659B273Ea7d6d13e6a2e2462123" : "",
  booster: ACTIVE_NETWORK === "testnet" ? "0x39e4B20401dc4cA45c0b14800c86Fc3Df953A245" : "",
  stocks:
    ACTIVE_NETWORK === "testnet"
      ? [{ symbol: "tAAPL", address: "0x44B8DA4948e3Eacb0f2E20a42c694Af49942e5C9" }]
      : [],
  // preset 0 always mirrors the live on-chain strategy basket; ids >= 1 are curated on the
  // contract and only listed here for labels.
  presets: [{ id: 0, name: "Congress Live", blurb: "The exact basket the engine runs, current epoch weights." }],
};

export const floorReady = FLOOR.router !== "";

// The Trade tab replaces the old COAT Swap tab. It stays out of the nav entirely until the
// venue contract is wired for the active network (testnet builds show it now; mainnet shows
// it in the launch commit).
export const TRADE_TAB_ENABLED = FLOOR.live || floorReady;

export const basketRouterAbi = [
  {
    type: "function",
    name: "buyStockEth",
    stateMutability: "payable",
    inputs: [
      { name: "stock", type: "address" },
      { name: "minOut", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "out", type: "uint256" }],
  },
  {
    type: "function",
    name: "buyBasketEth",
    stateMutability: "payable",
    inputs: [
      { name: "presetId", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "buyBasket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "presetId", type: "uint256" },
      { name: "usdgIn", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "buyBasketCoat",
    stateMutability: "nonpayable",
    inputs: [
      { name: "presetId", type: "uint256" },
      { name: "coatIn", type: "uint256" },
      { name: "minEthFromCoat", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sellBasket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "outCur", type: "uint8" },
      { name: "minOut", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "out", type: "uint256" }],
  },
  {
    type: "function",
    name: "sellStock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "stock", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "outCur", type: "uint8" },
      { name: "minOut", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "out", type: "uint256" }],
  },
  {
    type: "function",
    name: "minStockOut",
    stateMutability: "view",
    inputs: [
      { name: "stock", type: "address" },
      { name: "usdgIn", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "minUsdgOut",
    stateMutability: "view",
    inputs: [
      { name: "stock", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "preset",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "tokens", type: "address[]" },
      { name: "weights", type: "uint16[]" },
      { name: "name", type: "string" },
    ],
  },
  {
    type: "function",
    name: "feeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const erc20MiniAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const boosterEthUsdAbi = [
  {
    type: "function",
    name: "ethUsdFeed",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "ethUsdManualE8",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const aggregatorMiniAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

export const coatRouterQuoteAbi = [
  {
    type: "function",
    name: "quoteBuy",
    stateMutability: "view",
    inputs: [{ name: "ethIn", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
