import type { Address } from "viem";
import { ACTIVE_NETWORK } from "./chains";

// Playbooks config. LIVE on mainnet since 2026-08-28 (engine deployed and wired to the
// production Brokers/Booster/Floor, hourly keeper armed via the PLAYBOOKS_ENGINE secret).
export const PLAYBOOKS: { engine: Address | "" } = {
  engine:
    ACTIVE_NETWORK === "testnet"
      ? "0xb9d25e5D211C3AD08647F8826F33906F6b8D2463"
      : "0x3b39C832a906E7fE5292F6872c3D3f9eE8340438",
};

export const playbooksReady = PLAYBOOKS.engine !== "";

/** Playbooks are suspended (founder decision 2026-10-15): the panel is off the site and the
 *  keeper no longer runs orders (repository variable PLAYBOOKS_PAUSED=1). Enrolments and
 *  approvals stay on chain untouched, earnings stay claimable in the Booster. Set true, and
 *  PLAYBOOKS_PAUSED=0, to bring them back (move the engine onto the Floor v2 first). */
export const PLAYBOOKS_ON_SITE = false;

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
