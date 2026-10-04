import type { Address } from "viem";
import deployments from "../../deployments.json";
import { ACTIVE_NETWORK, activeChain } from "./chains";
import { ADDR } from "./config";
import type { DeskConfig } from "@/components/desk/data";

// The Desk's own contracts, per network. The basket, Booster, COAT and its router are the
// core's, so they come from the main address set. Absent on a network = no Desk there.
type DeskAddrs = {
  usdg: Address;
  desks: Address;
  engine: Address;
  depositRouter: Address;
  strategyId: number;
  deployBlock: number;
};

const net = (ACTIVE_NETWORK === "mainnet" ? deployments.mainnet : deployments.testnet) as { desk?: DeskAddrs };

export const DESK_CONFIG: DeskConfig | null = net.desk
  ? {
    chainId: activeChain.id,
    forkBlock: net.desk.deployBlock,
    usdg: net.desk.usdg,
    coat: ADDR.coat,
    desks: net.desk.desks,
    engine: net.desk.engine,
    registry: ADDR.strategyRegistry,
    booster: ADDR.booster,
    depositRouter: net.desk.depositRouter,
    coatRouter: ADDR.router as Address,
    strategyId: net.desk.strategyId,
  }
  : null;

// Two keys: the network must have Desk contracts AND the flag must be on. Production gets the
// flag only after the mainnet deploy, the design sign-off and the final checks.
export const DESK_TAB_ENABLED = DESK_CONFIG !== null && process.env.NEXT_PUBLIC_DESK_TAB === "1";
