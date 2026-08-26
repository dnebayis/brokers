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
  coat: Address | "";
  stocks: { symbol: string; address: Address }[];
  presets: { id: number; name: string; blurb: string }[];
} = {
  live: false,
  router:
    ACTIVE_NETWORK === "testnet" ? "0x5cEDF6954aD8EC29cc4c50A4f0a387D433D01490" : "",
  usdg: ACTIVE_NETWORK === "testnet" ? "0xca71484e6FA828dc261C7b4e902d3DF47542aDa4" : "",
  coat: ACTIVE_NETWORK === "testnet" ? "0xD3f44c7DD32D12C7a6776C23c839DEcA8196cf07" : "",
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
      { name: "wantEth", type: "bool" },
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
      { name: "wantEth", type: "bool" },
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
