import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { short } from "@/lib/format";
import {
  boosterFeedAbi,
  deskAccountAbi,
  deskEngineAbi,
  deskNftAbi,
  depositRouterAbi,
  erc20Abi,
  feedAbi,
  registryAbi,
} from "./abi";

// Everything the Desk tab (and the local lab) shows, read from the chain in one pass.

export type DeskConfig = {
  /** lab only: "fork" = local anvil fork (impersonated test wallet, faucet); "testnet" */
  mode?: "fork" | "testnet";
  rpc?: string;
  chainId: number;
  /** first block worth scanning for Desk events (the engine's deployment) */
  forkBlock?: number;
  testWallet?: Address;
  deployer?: Address;
  /** optional display names by token address; anything missing is read from the token */
  symbols?: Record<string, string>;
  usdg: Address;
  coat: Address;
  desks: Address;
  engine: Address;
  registry: Address;
  booster: Address;
  depositRouter: Address;
  coatRouter: Address;
  strategyId: number;
};

/** The lab's config file: the same fields with its own RPC and faucet wallet (plus test-venue
 *  addresses it ignores). */
export type LabConfig = DeskConfig & { rpc: string; deployer: Address };

export type Holding = {
  token: Address;
  symbol: string;
  amount: bigint;
  usd: number;
  price: number;
  weightNow: number;
  target: number;
  cost: number; // average-cost basis of what is still held, fees included
  pnl: number; // unrealized: usd - cost
};

/** Money in and out of one Desk, replayed from its transfers and the engine's events. */
export type Ledger = {
  deposited: number; // USDG that arrived from outside (deposits in any currency land as USDG)
  withdrawn: number; // USDG and stock taken out by the owner, stock at the price of that block
  realized: number; // sells: net proceeds minus the average cost of what was sold
  unrealized: number; // held stock: value now minus its cost
  fees: number; // engine fees this Desk paid
  pnl: number; // value now + withdrawn - deposited
  pnlPct: number; // pnl / deposited
};

export type Trait = { name: string; value: string };

export type ActivityKind = "buy" | "sell" | "fees";
export type Activity = { kind: ActivityKind; block: bigint; at: number; text: string; usd: number; tx: Hex; deskId?: bigint };

export type DeskView = {
  id: bigint;
  account: Address;
  image: string;
  traits: Trait[];
  paused: boolean;
  idle: bigint; // USDG in the Desk wallet
  investable: bigint; // the part the engine booked (deposits through the router, sell proceeds)
  principal: bigint; // what the owner put in, net of what they took out
  room: bigint; // how much more may be deposited under the pilot cap
  cap: bigint;
  holdings: Holding[];
  stockUsd: number;
  totalUsd: number;
  ledger: Ledger;
};

export type DeskState = {
  block: bigint;
  eth: bigint;
  coat: bigint;
  usdg: bigint;
  mintPrice: bigint;
  totalMinted: bigint;
  mintCap: bigint;
  mintOpen: boolean;
  feeBps: number;
  cap: bigint;
  owned: { id: bigint; image: string }[];
  basket: { token: Address; symbol: string; weight: number; price: number }[];
  epoch: bigint;
  ethUsd: number;
  desk?: DeskView;
  activity: Activity[];
  keeperLastAt: number;
};

/** @deprecated the lab's name for DeskState */
export type LabState = DeskState;

// token symbols read on chain, kept for the session (they never change)
const SYMBOLS = new Map<string, string>();

export const symbolOf = (cfg: DeskConfig, t: string) =>
  Object.entries(cfg.symbols ?? {}).find(([k]) => k.toLowerCase() === t.toLowerCase())?.[1] ??
  SYMBOLS.get(t.toLowerCase()) ?? short(t);

async function learnSymbols(client: PublicClient, cfg: DeskConfig, tokens: Address[]) {
  const unknown = tokens.filter((t) => symbolOf(cfg, t) === short(t));
  const names = await Promise.all(
    unknown.map((t) => client.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }).catch(() => "")),
  );
  unknown.forEach((t, i) => names[i] && SYMBOLS.set(t.toLowerCase(), names[i]));
}

/** Every stock the engine can hold: the names it ever got a pool for. */
async function engineStocks(client: PublicClient, cfg: DeskConfig): Promise<Address[]> {
  const n = await client.readContract({ address: cfg.engine, abi: deskEngineAbi, functionName: "routedStockCount" });
  return Promise.all(
    Array.from({ length: Number(n) }, (_, i) =>
      client.readContract({ address: cfg.engine, abi: deskEngineAbi, functionName: "routedStocks", args: [BigInt(i)] })),
  );
}

function decodeUri(uri: string): { image: string; traits: Trait[] } {
  try {
    const json = JSON.parse(atob(uri.split(",")[1] ?? "")) as {
      image?: string;
      attributes?: { trait_type: string; value: string | number; display_type?: string }[];
    };
    const traits = (json.attributes ?? [])
      .filter((a) => !a.display_type)
      .map((a) => ({ name: a.trait_type, value: String(a.value) }));
    return { image: json.image ?? "", traits };
  } catch {
    return { image: "", traits: [] };
  }
}

export async function readDesk(
  client: PublicClient,
  cfg: DeskConfig,
  me: Address | undefined,
  selected: bigint | null,
): Promise<DeskState> {
  const [block, mintPrice, totalMinted, mintCap, mintOpen, feeBps, cap, basketRaw, ethFloor, slip, routed] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({ address: cfg.desks, abi: deskNftAbi, functionName: "mintPrice" }),
    client.readContract({ address: cfg.desks, abi: deskNftAbi, functionName: "totalMinted" }),
    client.readContract({ address: cfg.desks, abi: deskNftAbi, functionName: "mintCap" }),
    client.readContract({ address: cfg.desks, abi: deskNftAbi, functionName: "mintOpen" }),
    client.readContract({ address: cfg.engine, abi: deskEngineAbi, functionName: "feeBps" }),
    client.readContract({ address: cfg.engine, abi: deskEngineAbi, functionName: "pilotCapUsdg" }),
    client.readContract({ address: cfg.registry, abi: registryAbi, functionName: "getBasket", args: [BigInt(cfg.strategyId)] }),
    client.readContract({ address: cfg.depositRouter, abi: depositRouterAbi, functionName: "minUsdgForEth", args: [10n ** 18n] }),
    client.readContract({ address: cfg.depositRouter, abi: depositRouterAbi, functionName: "maxSlippageBps" }),
    engineStocks(client, cfg),
  ]);
  const ethUsd = Number(ethFloor) / 1e6 / (1 - Number(slip) / 10_000);
  // what a Desk can hold: the names the engine has pools for (basket names without one are
  // skipped by the engine and shown at weight 0 here)
  const stocks = routed;
  await learnSymbols(client, cfg, [...new Set([...stocks, ...basketRaw[0]])]);

  const prices: Record<string, number> = {};
  await Promise.all(
    [...new Set([...stocks, ...basketRaw[0]])].map(async (t) => {
      const feed = await client.readContract({ address: cfg.booster, abi: boosterFeedAbi, functionName: "stockFeed", args: [t] });
      if (feed === "0x0000000000000000000000000000000000000000") return;
      const round = await client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" });
      prices[t.toLowerCase()] = Number(round[1]) / 1e8;
    }),
  );
  const basket = basketRaw[0].map((t, i) => ({
    token: t,
    symbol: symbolOf(cfg, t),
    weight: basketRaw[1][i] / 100,
    price: prices[t.toLowerCase()] ?? 0,
  }));

  let eth = 0n, coat = 0n, usdg = 0n;
  const owned: { id: bigint; image: string }[] = [];
  if (me) {
    [eth, coat, usdg] = await Promise.all([
      client.getBalance({ address: me }),
      client.readContract({ address: cfg.coat, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
      client.readContract({ address: cfg.usdg, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
    ]);
    const ids = Array.from({ length: Number(totalMinted) }, (_, i) => BigInt(i + 1));
    const owners = await Promise.all(
      ids.map((id) => client.readContract({ address: cfg.desks, abi: deskNftAbi, functionName: "ownerOf", args: [id] })),
    );
    const mine = ids.filter((_, i) => owners[i].toLowerCase() === me.toLowerCase());
    const uris = await Promise.all(
      mine.map((id) => client.readContract({ address: cfg.desks, abi: deskNftAbi, functionName: "tokenURI", args: [id] })),
    );
    mine.forEach((id, i) => owned.push({ id, image: decodeUri(uris[i]).image }));
  }

  // keeper activity, all desks, newest first, with block times
  const from = cfg.forkBlock ? BigInt(cfg.forkBlock) : block > 20_000n ? block - 20_000n : 0n;
  const logs = await client.getContractEvents({ address: cfg.engine, abi: deskEngineAbi, fromBlock: from, toBlock: block });
  const recent = logs.slice(-40).reverse();
  const times = new Map<bigint, number>();
  await Promise.all(
    [...new Set(recent.map((l) => l.blockNumber ?? 0n))].map(async (b) => {
      const blk = await client.getBlock({ blockNumber: b });
      times.set(b, Number(blk.timestamp));
    }),
  );
  const activity: Activity[] = [];
  for (const l of recent) {
    const args = l.args as Record<string, unknown>;
    const usd = (v: unknown) => Number(v as bigint) / 1e6;
    const b = l.blockNumber ?? 0n;
    const base = { block: b, at: times.get(b) ?? 0, tx: l.transactionHash as Hex, deskId: args.deskId as bigint | undefined };
    if (l.eventName === "BasketBought")
      activity.push({ ...base, kind: "buy", usd: usd(args.usdgSpent), text: `bought the basket (epoch ${args.epoch})` });
    else if (l.eventName === "StockBought")
      activity.push({ ...base, kind: "buy", usd: usd(args.usdgSpent), text: `bought ${symbolOf(cfg, args.stock as string)}` });
    else if (l.eventName === "StockSold")
      activity.push({ ...base, kind: "sell", usd: usd(args.usdgOut), text: `sold ${symbolOf(cfg, args.stock as string)}` });
    else if (l.eventName === "FeesFlushed")
      activity.push({ ...base, kind: "fees", usd: usd(args.usdgIn), text: "service fees sent on as ETH" });
  }
  const keeperLastAt = activity[0]?.at ?? 0;

  const state: DeskState = {
    block, eth, coat, usdg, mintPrice, totalMinted, mintCap, mintOpen, feeBps: Number(feeBps), cap,
    owned, basket, epoch: basketRaw[2], ethUsd, activity, keeperLastAt,
  };

  const id = selected && owned.some((o) => o.id === selected) ? selected : owned[0]?.id;
  if (!id) return state;
  const account = await client.readContract({ address: cfg.desks, abi: deskNftAbi, functionName: "accountOf", args: [id] });
  const [uri, paused, idle, principal, room, investable, amounts] = await Promise.all([
    client.readContract({ address: cfg.desks, abi: deskNftAbi, functionName: "tokenURI", args: [id] }),
    client.readContract({ address: account, abi: deskAccountAbi, functionName: "enginePaused" }),
    client.readContract({ address: cfg.usdg, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    client.readContract({ address: cfg.engine, abi: deskEngineAbi, functionName: "principalOf", args: [id] }),
    client.readContract({ address: cfg.engine, abi: deskEngineAbi, functionName: "depositRoomOf", args: [id] }),
    client.readContract({ address: cfg.engine, abi: deskEngineAbi, functionName: "investableOf", args: [id] }),
    Promise.all(stocks.map((t) => client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [account] }))),
  ]);
  const usd = stocks.map((t, i) => (Number(amounts[i]) / 1e18) * (prices[t.toLowerCase()] ?? 0));
  const stockUsd = usd.reduce((x, y) => x + y, 0);
  const totalUsd = stockUsd + Number(idle) / 1e6;
  const books = await replayLedger(client, cfg, id, account, from, block, logs, stocks);
  const targets: Record<string, number> = {};
  basket.forEach((b) => (targets[b.token.toLowerCase()] = b.weight));
  const holdings = stocks
    .map((t, i) => {
      const cost = books.cost[t.toLowerCase()] ?? 0;
      return {
        token: t,
        symbol: symbolOf(cfg, t),
        amount: amounts[i],
        usd: usd[i],
        price: prices[t.toLowerCase()] ?? 0,
        weightNow: stockUsd > 0 ? (usd[i] / stockUsd) * 100 : 0,
        target: targets[t.toLowerCase()] ?? 0,
        cost,
        pnl: amounts[i] > 0n ? usd[i] - cost : 0,
      };
    })
    .filter((h) => h.amount > 0n || h.target > 0)
    .sort((a, b) => b.target - a.target || b.usd - a.usd);
  const unrealized = holdings.reduce((x, h) => x + h.pnl, 0);
  const pnl = totalUsd + books.withdrawn - books.deposited;
  const { image, traits } = decodeUri(uri);
  state.desk = {
    id, account, image, traits, paused, idle, investable, principal, room, cap, holdings, stockUsd, totalUsd,
    ledger: {
      deposited: books.deposited,
      withdrawn: books.withdrawn,
      realized: books.realized,
      unrealized,
      fees: books.fees,
      pnl,
      pnlPct: books.deposited > 0 ? (pnl / books.deposited) * 100 : 0,
    },
  };
  return state;
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

type EngineLog = {
  eventName?: string;
  args?: unknown;
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: Hex | null;
};

/**
 * Average-cost books for one Desk. Walks, in chain order, every token transfer touching the
 * Desk wallet and the engine's events for this Desk:
 *   buy (BasketBought/StockBought): the stock that arrived in that tx is a lot, costed at the
 *     USDG spent (fee included), split across names by value at that block for basket buys;
 *   sell (StockSold): realized = net proceeds - average cost of the shares sold;
 *   owner withdrawal: shares leave at their average cost, their value at that block counts as
 *     money taken out; USDG in from outside the engine is a deposit, USDG out is a withdrawal.
 */
async function replayLedger(
  client: PublicClient,
  cfg: DeskConfig,
  deskId: bigint,
  acct: Address,
  from: bigint,
  to: bigint,
  engineLogs: EngineLog[],
  stocks: Address[],
) {
  const engine = cfg.engine.toLowerCase();
  const tokens = [cfg.usdg, ...stocks];
  const [ins, outs] = await Promise.all([
    Promise.all(tokens.map((t) => client.getLogs({ address: t, event: TRANSFER, args: { to: acct }, fromBlock: from, toBlock: to }))),
    Promise.all(tokens.map((t) => client.getLogs({ address: t, event: TRANSFER, args: { from: acct }, fromBlock: from, toBlock: to }))),
  ]);

  const feedOf = new Map<string, Address>();
  const priceAt = async (token: string, block: bigint) => {
    let feed = feedOf.get(token);
    if (!feed) {
      feed = await client.readContract({ address: cfg.booster, abi: boosterFeedAbi, functionName: "stockFeed", args: [token as Address] });
      feedOf.set(token, feed);
    }
    if (/^0x0+$/.test(feed)) return 0; // no feed for this name: valued at nothing
    // the price at that block; an endpoint without historical state answers with today's
    const r = await client
      .readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData", blockNumber: block })
      .catch(() => client.readContract({ address: feed as Address, abi: feedAbi, functionName: "latestRoundData" }));
    return Number(r[1]) / 1e8;
  };

  type Step =
    | { order: [bigint, number]; kind: "engine"; log: EngineLog }
    | { order: [bigint, number]; kind: "in" | "out"; token: string; amount: bigint; other: string; tx: Hex; block: bigint };
  const steps: Step[] = [];
  const buyTxs = new Set<string>();
  for (const l of engineLogs) {
    const args = l.args as Record<string, unknown>;
    if (args.deskId !== deskId) continue;
    if (l.eventName === "BasketBought" || l.eventName === "StockBought") buyTxs.add(l.transactionHash as string);
    steps.push({ order: [l.blockNumber ?? 0n, l.logIndex ?? 0], kind: "engine", log: l });
  }
  tokens.forEach((t, i) => {
    for (const l of ins[i]) {
      steps.push({ order: [l.blockNumber ?? 0n, l.logIndex ?? 0], kind: "in", token: t.toLowerCase(), amount: l.args.value ?? 0n,
        other: (l.args.from ?? "").toLowerCase(), tx: l.transactionHash as Hex, block: l.blockNumber ?? 0n });
    }
    for (const l of outs[i]) {
      steps.push({ order: [l.blockNumber ?? 0n, l.logIndex ?? 0], kind: "out", token: t.toLowerCase(), amount: l.args.value ?? 0n,
        other: (l.args.to ?? "").toLowerCase(), tx: l.transactionHash as Hex, block: l.blockNumber ?? 0n });
    }
  });
  steps.sort((a, b) => (a.order[0] === b.order[0] ? a.order[1] - b.order[1] : a.order[0] < b.order[0] ? -1 : 1));

  const usdgKey = cfg.usdg.toLowerCase();
  const qty: Record<string, number> = {};
  const cost: Record<string, number> = {};
  let deposited = 0, withdrawn = 0, realized = 0, fees = 0;
  // stock that arrived inside a buy tx, waiting for the buy event (emitted after the transfers)
  const pendingLots = new Map<string, { token: string; amount: number; block: bigint }[]>();

  for (const st of steps) {
    if (st.kind === "in") {
      if (st.token === usdgKey) {
        if (st.other !== engine) deposited += Number(st.amount) / 1e6;
        continue;
      }
      const amt = Number(st.amount) / 1e18;
      if (buyTxs.has(st.tx)) {
        const lots = pendingLots.get(st.tx) ?? [];
        lots.push({ token: st.token, amount: amt, block: st.block });
        pendingLots.set(st.tx, lots);
      } else {
        // stock sent in from outside: costed at that block's price
        qty[st.token] = (qty[st.token] ?? 0) + amt;
        cost[st.token] = (cost[st.token] ?? 0) + amt * (await priceAt(st.token, st.block));
        deposited += amt * (await priceAt(st.token, st.block));
      }
      continue;
    }
    if (st.kind === "out") {
      if (st.other === engine) continue; // the engine's pull; the sell/buy event books it
      if (st.token === usdgKey) {
        withdrawn += Number(st.amount) / 1e6;
        continue;
      }
      const amt = Number(st.amount) / 1e18;
      const avg = qty[st.token] > 0 ? cost[st.token] / qty[st.token] : 0;
      qty[st.token] = Math.max(0, (qty[st.token] ?? 0) - amt);
      cost[st.token] = Math.max(0, (cost[st.token] ?? 0) - avg * amt);
      withdrawn += amt * (await priceAt(st.token, st.block));
      continue;
    }
    if (st.kind !== "engine") continue;
    const l = st.log;
    const args = l.args as Record<string, unknown>;
    const n = (v: unknown) => Number(v as bigint);
    if (l.eventName === "BasketBought" || l.eventName === "StockBought") {
      const spent = n(args.usdgSpent) / 1e6;
      fees += n(args.fee) / 1e6;
      const lots = pendingLots.get(l.transactionHash as string) ?? [];
      const values = await Promise.all(lots.map(async (x) => x.amount * (await priceAt(x.token, x.block))));
      const sum = values.reduce((x, y) => x + y, 0);
      lots.forEach((x, i) => {
        qty[x.token] = (qty[x.token] ?? 0) + x.amount;
        cost[x.token] = (cost[x.token] ?? 0) + (sum > 0 ? (spent * values[i]) / sum : 0);
      });
      pendingLots.delete(l.transactionHash as string);
    } else if (l.eventName === "StockSold") {
      const token = (args.stock as string).toLowerCase();
      const sold = n(args.stockIn) / 1e18;
      const net = (n(args.usdgOut) - n(args.fee)) / 1e6;
      fees += n(args.fee) / 1e6;
      const avg = qty[token] > 0 ? cost[token] / qty[token] : 0;
      realized += net - avg * sold;
      qty[token] = Math.max(0, (qty[token] ?? 0) - sold);
      cost[token] = Math.max(0, (cost[token] ?? 0) - avg * sold);
    }
  }
  return { deposited, withdrawn, realized, fees, cost };
}
