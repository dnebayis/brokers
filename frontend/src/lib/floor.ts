import type { Address } from "viem";
import { ACTIVE_NETWORK } from "./chains";

// Trade-terminal config. LIVE on mainnet since 2026-08-27 (router deployed, smoke-tested
// on-chain, keeper flush armed). The testnet addresses are the staging deployment used to
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
  live: true,
  router:
    ACTIVE_NETWORK === "testnet"
      ? "0x927E23B683AcBbeB7F2FbBFa035aF80acfE0b31a"
      : "0x478F22A32663cF37702d65352A7579A73e61FDc7",
  usdg:
    ACTIVE_NETWORK === "testnet"
      ? "0xca71484e6FA828dc261C7b4e902d3DF47542aDa4"
      : "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  usdgDecimals: ACTIVE_NETWORK === "testnet" ? 18 : 6,
  coat:
    ACTIVE_NETWORK === "testnet"
      ? "0xD3f44c7DD32D12C7a6776C23c839DEcA8196cf07"
      : "0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833",
  coatRouter:
    ACTIVE_NETWORK === "testnet"
      ? "0x5fBCa6b6Dd403659B273Ea7d6d13e6a2e2462123"
      : "0x740baEEF895444a659fD0fc5Dc213BEDe7d1EaaF",
  booster:
    ACTIVE_NETWORK === "testnet"
      ? "0x39e4B20401dc4cA45c0b14800c86Fc3Df953A245"
      : "0x7bAf435847A4b45c2e22a7fd13549C3192C95953",
  stocks:
    ACTIVE_NETWORK === "testnet"
      ? [{ symbol: "tAAPL", address: "0x44B8DA4948e3Eacb0f2E20a42c694Af49942e5C9" }]
      : [
          // every name the route manifest wires on v3 (26), the launch seven first
          { symbol: "INTC", address: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681" },
          { symbol: "SPCX", address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa" },
          { symbol: "MU", address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD" },
          { symbol: "NVDA", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
          { symbol: "AAPL", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" },
          { symbol: "MSFT", address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74" },
          { symbol: "AMD", address: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC" },
          { symbol: "AMZN", address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54" },
          { symbol: "ASML", address: "0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA" },
          { symbol: "BABA", address: "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4" },
          { symbol: "CRCL", address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5" },
          { symbol: "DELL", address: "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd" },
          { symbol: "GME", address: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E" },
          { symbol: "GOOGL", address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3" },
          { symbol: "META", address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35" },
          { symbol: "MSTR", address: "0xec262a75e413fAfD0dF80480274532C79D42da09" },
          { symbol: "PLTR", address: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A" },
          { symbol: "QQQ", address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68" },
          { symbol: "SGOV", address: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5" },
          { symbol: "SLV", address: "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f" },
          { symbol: "SNDK", address: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400" },
          { symbol: "SPY", address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" },
          { symbol: "TSLA", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" },
          { symbol: "TSM", address: "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA" },
          { symbol: "USAR", address: "0xd917B029C761D264c6A312BBbcDA868658eF86a6" },
          { symbol: "USO", address: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344" },
        ],
  // preset 0 always mirrors the live on-chain strategy basket; ids >= 1 are curated on the
  // contract and only listed here for labels.
  presets: [{ id: 0, name: "Congress Live", blurb: "The exact basket the engine runs, current epoch weights." }],
};

// Names the basket can hold that have no v3 pool (routed for the Booster through Rialto), so
// the terminal can name what a basket buy skips instead of printing an address.
const SKIP_ONLY: Record<string, string> =
  ACTIVE_NETWORK === "testnet"
    ? {}
    : {
  "0xcbb95bbf36099d34da091dc6fa6f49efa257cee3": "CLSK",
  "0x6330d8c3178a418788df01a47479c0ce7ccf450b": "COIN",
  "0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3": "CRWV",
  "0x7f0abef0c07280f82c6a08ead09ded6bae2c13fc": "EWY",
  "0x558378e000d634a36593e338ebacdd6207640efe": "IONQ",
  "0x9d9c6684f596f66a64c030b93a886d51fd4d7931": "NBIS",
  "0xb0992820e760d836549ba69bc7598b4af75dee03": "ORCL",
  "0x284358abc07f9359f19f4b5b4ac91901be2597ba": "RGTI",
  "0x3b14c39e89d60d627b42a1a4ca45b5bb45fc12e2": "RKLB",
      };

/** Ticker for any stock token the basket can name, or undefined. */
export function floorSymbol(address: string): string | undefined {
  const a = address.toLowerCase();
  return FLOOR.stocks.find((s) => s.address.toLowerCase() === a)?.symbol ?? SKIP_ONLY[a];
}

export const floorReady = FLOOR.router !== "";

// The Trade tab replaces the old COAT Swap tab. It stays out of the nav entirely until the
// venue contract is wired for the active network (testnet builds show it now; mainnet shows
// it in the launch commit).
export const TRADE_TAB_ENABLED = FLOOR.live || floorReady;

export const basketRouterAbi = [
  {
    // v2 only: what a preset buy actually buys (routed names, weights spread to 10,000) and
    // the names it skips for want of a pool. v1 has no such view; the terminal falls back.
    type: "function",
    name: "basketLegs",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "tokens", type: "address[]" },
      { name: "weights", type: "uint16[]" },
      { name: "skipped", type: "address[]" },
    ],
  },
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
  {
    type: "function",
    name: "quoteSell",
    stateMutability: "view",
    inputs: [{ name: "coatIn", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
