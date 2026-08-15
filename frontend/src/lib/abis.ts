// Minimal ABIs (viem `as const` for full type inference) — only what the UI calls.

export const brokerAbi = [
  { type: "event", name: "Minted", anonymous: false, inputs: [
    { name: "to", type: "address", indexed: true }, { name: "tokenId", type: "uint256", indexed: true },
    { name: "account", type: "address", indexed: false }, { name: "paidWei", type: "uint256", indexed: false },
  ] },
  { type: "function", name: "mint", stateMutability: "payable", inputs: [{ name: "qty", type: "uint256" }], outputs: [{ name: "tokenIds", type: "uint256[]" }] },
  { type: "function", name: "mintPriceWei", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalMinted", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MAX_SUPPLY", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "WALLET_CAP", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mintOpen", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "mintedBy", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "safeTransferFrom", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "activate", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "activated", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "ACTIVATION_BURN", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "accountOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

export const coatAbi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const boosterAbi = [
  { type: "function", name: "activeShares", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "claimFor", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "claimBatch", stateMutability: "nonpayable", inputs: [{ name: "tokenIds", type: "uint256[]" }], outputs: [] },
  { type: "function", name: "claimable", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [
    { name: "tokens", type: "address[]" }, { name: "amounts", type: "uint256[]" },
  ] },
] as const;

export const strategyRegistryAbi = [
  { type: "function", name: "getBasket", stateMutability: "view", inputs: [{ name: "strategyId", type: "uint256" }], outputs: [
    { name: "tokens", type: "address[]" }, { name: "weightsBps", type: "uint16[]" }, { name: "epoch", type: "uint64" },
  ] },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [
    { name: "to", type: "address" }, { name: "value", type: "uint256" },
  ], outputs: [{ type: "bool" }] },
] as const;

export const brokerAccountAbi = [
  { type: "function", name: "execute", stateMutability: "payable", inputs: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
  ], outputs: [{ type: "bytes" }] },
] as const;

// CoatRouter — thin wrapper over the v4 pool (deploy separately, then set ADDR.router).
export const routerAbi = [
  { type: "function", name: "buy", stateMutability: "payable", inputs: [{ name: "minCoatOut", type: "uint256" }, { name: "to", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "sell", stateMutability: "nonpayable", inputs: [{ name: "coatIn", type: "uint256" }, { name: "minEthOut", type: "uint256" }, { name: "to", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "quoteBuy", stateMutability: "view", inputs: [{ name: "ethIn", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "quoteSell", stateMutability: "view", inputs: [{ name: "coatIn", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;
