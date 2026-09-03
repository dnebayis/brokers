import type { Address } from "viem";
import { ACTIVE_NETWORK } from "./chains";

// Gift vault config. The vault holds donated NFTs and gifts one, every on-chain interval,
// to a random ACTIVE Broker's own wallet; the winner is derived from a block hash the
// contract picks, so nobody chooses who wins. Empty address = the panels stay hidden until
// the launch commit pastes the deployed vault in here (same pattern as playbooks.ts).
export const GIFTS: { vault: Address | ""; fromBlock: bigint } = {
  vault: ACTIVE_NETWORK === "testnet" ? "" : "",
  fromBlock: 0n,
};

export const giftsReady = GIFTS.vault !== "";

export const giftVaultAbi = [
  { type: "event", name: "Gifted", anonymous: false, inputs: [
    { name: "round", type: "uint256", indexed: true },
    { name: "brokerId", type: "uint256", indexed: true },
    { name: "nft", type: "address", indexed: true },
    { name: "id", type: "uint256", indexed: false },
    { name: "wallet", type: "address", indexed: false },
    { name: "seed", type: "bytes32", indexed: false },
  ] },
  { type: "event", name: "Deposited", anonymous: false, inputs: [
    { name: "nft", type: "address", indexed: true },
    { name: "id", type: "uint256", indexed: true },
    { name: "from", type: "address", indexed: true },
  ] },
  { type: "function", name: "open", stateMutability: "view", inputs: [], outputs: [
    { name: "nft", type: "address" }, { name: "id", type: "uint256" },
    { name: "drawBlock", type: "uint64" }, { name: "openedAt", type: "uint64" },
  ] },
  { type: "function", name: "lastGiftAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "interval", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "queuedCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "roundCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "upcoming", stateMutability: "view", inputs: [{ name: "n", type: "uint256" }], outputs: [
    { type: "tuple[]", components: [{ name: "nft", type: "address" }, { name: "id", type: "uint256" }] },
  ] },
] as const;

// The slice of ERC-721 the gift panels need: who holds a gift now, how to move it out of a
// Broker wallet, and what to call it.
export const nftAbi = [
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "safeTransferFrom", stateMutability: "nonpayable", inputs: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "tokenId", type: "uint256" },
  ], outputs: [] },
] as const;
