// Minimal ABIs for the local Desk lab (desk/ contracts on an anvil fork). Only what the page
// reads or sends; the full ABIs live in desk/out after `forge build`.

const u = (name: string) => ({ name, type: "uint256" }) as const;
const a = (name: string) => ({ name, type: "address" }) as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [a("a")], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [a("o"), a("s")], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [a("s"), u("v")], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [a("to"), u("v")], outputs: [{ type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [a("to"), u("v")], outputs: [] },
] as const;

export const deskNftAbi = [
  { type: "function", name: "mintPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalMinted", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [u("id")], outputs: [{ type: "address" }] },
  { type: "function", name: "accountOf", stateMutability: "view", inputs: [u("id")], outputs: [{ type: "address" }] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [u("id")], outputs: [{ type: "string" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [], outputs: [u("id"), a("account")] },
  { type: "function", name: "transferFrom", stateMutability: "nonpayable", inputs: [a("from"), a("to"), u("id")], outputs: [] },
] as const;

export const deskAccountAbi = [
  { type: "function", name: "enginePaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "setEnginePaused", stateMutability: "nonpayable", inputs: [{ name: "p", type: "bool" }], outputs: [] },
  {
    type: "function", name: "execute", stateMutability: "payable",
    inputs: [a("to"), u("value"), { name: "data", type: "bytes" }, { name: "op", type: "uint8" }],
    outputs: [{ type: "bytes" }],
  },
] as const;

export const deskEngineAbi = [
  { type: "function", name: "deployedUsdg", stateMutability: "view", inputs: [u("id")], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pilotCapUsdg", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "feesAccrued", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "event", name: "BasketBought", inputs: [{ name: "deskId", type: "uint256", indexed: true }, u("usdgSpent"), u("fee"), { name: "epoch", type: "uint64" }] },
  { type: "event", name: "StockBought", inputs: [{ name: "deskId", type: "uint256", indexed: true }, { name: "stock", type: "address", indexed: true }, u("usdgSpent"), u("fee"), { name: "epoch", type: "uint64" }] },
  { type: "event", name: "StockSold", inputs: [{ name: "deskId", type: "uint256", indexed: true }, { name: "stock", type: "address", indexed: true }, u("stockIn"), u("usdgOut"), u("fee")] },
  { type: "event", name: "FeesFlushed", inputs: [u("usdgIn"), u("ethOut"), u("toBooster"), u("toTreasury")] },
] as const;

export const registryAbi = [
  {
    type: "function", name: "getBasket", stateMutability: "view", inputs: [u("id")],
    outputs: [{ type: "address[]" }, { type: "uint16[]" }, { type: "uint64" }],
  },
] as const;

export const boosterFeedAbi = [
  { type: "function", name: "stockFeed", stateMutability: "view", inputs: [a("t")], outputs: [{ type: "address" }] },
] as const;

export const feedAbi = [
  {
    type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
    outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
  },
] as const;

export const depositRouterAbi = [
  { type: "function", name: "depositUsdg", stateMutability: "nonpayable", inputs: [u("deskId"), u("amount")], outputs: [] },
  { type: "function", name: "depositEth", stateMutability: "payable", inputs: [u("deskId"), u("minUsdgOut")], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "depositCoat", stateMutability: "nonpayable",
    inputs: [u("deskId"), u("coatIn"), u("minEthOut"), u("minUsdgOut")], outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "minUsdgForEth", stateMutability: "view", inputs: [u("ethIn")], outputs: [{ type: "uint256" }] },
] as const;

export const coatRouterAbi = [
  { type: "function", name: "quoteSell", stateMutability: "view", inputs: [u("coatIn")], outputs: [{ type: "uint256" }] },
] as const;
