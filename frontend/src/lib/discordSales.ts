// Server-side plumbing for the Discord sales bot (the only Discord feature left after the
// holder-verification bot was retired in favour of an external solution). One chain client
// with the public RPC's Origin header, an Upstash-style KV for the sweep cursor and the
// OpenSea image cache, and the OpenSea account read used by the workflow's debug input.
// Secrets are read from env and never logged.

import { createPublicClient, fallback, http } from "viem";
import { activeChain, RPC_PUBLIC_FIRST } from "./chains";

export const env = {
  recheckSecret: () => process.env.RECHECK_SECRET ?? "",
  kvUrl: () => process.env.KV_REST_API_URL ?? "",
  kvToken: () => process.env.KV_REST_API_TOKEN ?? "",
};

export const serverClient = createPublicClient({
  chain: activeChain,
  transport: fallback(
    RPC_PUBLIC_FIRST.map((url) =>
      http(url, { fetchOptions: { headers: { Origin: "https://www.coattail.cash" } } }),
    ),
  ),
});

export async function openseaBio(address: string): Promise<string | null> {
  const key = process.env.OPENSEA_API_KEY ?? "";
  if (!key) return null;
  try {
    const res = await fetch(`https://api.opensea.io/api/v2/accounts/${address}`, {
      headers: { "x-api-key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.bio === "string" ? data.bio : "";
  } catch {
    return null;
  }
}

// ── KV (Upstash REST protocol) ──────────────────────────────────────────────
export function kvConfigured(): boolean {
  return Boolean(env.kvUrl() && env.kvToken());
}

// Throws when KV is configured but unreachable (expired token, outage): a caller that keeps a
// cursor there must not mistake that for "no cursor yet" and replay history.
async function kv(cmd: (string | number)[]): Promise<{ result?: unknown } | null> {
  if (!kvConfigured()) return null;
  const res = await fetch(env.kvUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${env.kvToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`kv ${cmd[0]} failed: ${res.status}`);
  return res.json();
}

export async function kvGet(k: string): Promise<string | null> {
  const res = await kv(["GET", k]);
  const v = res?.result;
  return typeof v === "string" && v ? v : null;
}

export async function kvSet(k: string, v: string): Promise<void> {
  await kv(["SET", k, v]);
}
