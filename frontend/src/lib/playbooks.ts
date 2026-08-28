import type { Address } from "viem";
import { ACTIVE_NETWORK } from "./chains";

// Playbooks config. Same launch pattern as The Floor: the mainnet address lands here in
// the launch commit; until then the panel simply doesn't render on mainnet.
export const PLAYBOOKS: { engine: Address | "" } = {
  engine:
    ACTIVE_NETWORK === "testnet" ? "0xb9d25e5D211C3AD08647F8826F33906F6b8D2463" : "",
};

export const playbooksReady = PLAYBOOKS.engine !== "";

// PlaybookEngine.Mode
export const PB_MODE = { NONE: 0, SWEEP: 1, TO_USDG: 2, TO_COAT: 3 } as const;

export const playbookEngineAbi = [
  {
    type: "function",
    name: "setPlaybook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "autoClaim", type: "bool" },
      { name: "mode", type: "uint8" },
      { name: "dest", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "clearPlaybook",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setPaused",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "paused", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "playbookOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "autoClaim", type: "bool" },
      { name: "mode", type: "uint8" },
      { name: "dest", type: "address" },
      { name: "paused", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "setterOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
