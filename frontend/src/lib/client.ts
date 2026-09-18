import { createPublicClient, fallback, http } from "viem";
import { activeChain, RPC_HTTP, RPC_PUBLIC_FIRST } from "./chains";

// Two read clients, split by what the call protects:
//  - `client` (metered provider first): wallet-critical paths — pre-transaction reads,
//    receipt waits, ownership discovery. Reliability is worth the quota.
//  - `publicClient` (official endpoint first): ambient reads — metrics, proof panel,
//    leaderboards, valuations. These are the overwhelming bulk of traffic and were
//    draining the metered quota; the free endpoint handles them (CORS *, wide getLogs),
//    with the metered provider left as the fallback rather than the default.
// Both use JSON-RPC + Multicall3 batching to keep call counts low under concurrency.
//
// `rank` matters more than it looks: when the metered provider hit its monthly cap it
// answered every request with a 429, and a fixed order kept sending it to the dead endpoint
// first on every single read. Ranking demotes an endpoint that is erroring or slow, so a
// provider outage degrades latency instead of correctness.
const RANK = { interval: 60_000, sampleCount: 3 } as const;

// The metered key is locked to the site's origin on the provider side. A browser sends
// `Origin` on its own, so the key works in the app; a Vercel function sends none, and the
// provider answered every server-side call with 403 "Unspecified origin not on whitelist".
// That left the API routes with a single endpoint and no fallback: one public-RPC hiccup
// was a 502 storm on /api/broker/[id] (2026-09-14). Server-side requests now carry the
// site's origin. Browsers drop a hand-set Origin header, so this is server-only by design.
const SERVER_FETCH = typeof window === "undefined"
  ? { fetchOptions: { headers: { Origin: "https://coattail.cash" } } }
  : {};

const transport = (url: string) => http(url, { batch: { wait: 16 }, retryCount: 2, ...SERVER_FETCH });

export const client = createPublicClient({
  chain: activeChain,
  transport: fallback(RPC_HTTP.map(transport), { rank: RANK }),
  batch: { multicall: { wait: 16 } },
});

export const publicClient = createPublicClient({
  chain: activeChain,
  transport: fallback(RPC_PUBLIC_FIRST.map(transport), { rank: RANK }),
  batch: { multicall: { wait: 16 } },
});

// Every flow that sends a transaction waits for it here, so this is the one place that
// knows a hash exists. It is announced so the status line can link the explorer without
// each of the ~25 call sites having to thread the hash through by hand.
export const txEvents = new EventTarget();

export async function waitForSuccessfulReceipt(hash: `0x${string}`) {
  txEvents.dispatchEvent(new CustomEvent("sent", { detail: hash }));
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted on-chain.");
  return receipt;
}
