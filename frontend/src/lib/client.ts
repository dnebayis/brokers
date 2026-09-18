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
// No `rank`. viem's ranking pings both endpoints every minute and moves the better-scoring
// one to the FRONT; the metered provider is almost always the faster of the two, so the
// "public first" client was quietly sending nearly every ambient read to the metered key
// (the ~$300/month it cost in 2026-09). A fixed order does what the comment above says: the
// public endpoint answers, the metered one is used only when the public one fails. A dead or
// rate-limited endpoint is retried twice, then the next transport answers, so an outage costs
// latency, not correctness.

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
  transport: fallback(RPC_HTTP.map(transport)),
  batch: { multicall: { wait: 16 } },
});

export const publicClient = createPublicClient({
  chain: activeChain,
  transport: fallback(RPC_PUBLIC_FIRST.map(transport)),
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
