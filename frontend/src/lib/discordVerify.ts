// Server-side plumbing for the Discord holder-verification bot. Design constraints:
//   - ADDRESS-ONLY verification (owner's decision): the member pastes a wallet address,
//     no connection and no signature. The impersonation tradeoff is contained by the
//     one-address-one-discord-user claim below — an address that verified once cannot
//     be claimed by a second account — and by the role staying cosmetic;
//   - Discord talks to us over the Interactions webhook (no gateway process), which
//     makes the whole bot serverless on the existing Vercel deployment;
//   - the wallet<->discord mapping lives in an Upstash-style REST KV so a daily
//     re-check can strip roles from wallets that sold. Without KV envs, verification
//     still works — only the re-check and the duplicate-claim lock are disabled.
// Secrets (bot token, HMAC key) are read from env and never logged.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createPublicClient, fallback, http } from "viem";
import { ADDR } from "./config";
import { activeChain, RPC_PUBLIC_FIRST } from "./chains";
import { brokerAbi } from "./abis";

const DISCORD_API = "https://discord.com/api/v10";
const STATE_TTL_MS = 15 * 60_000;

export const env = {
  botToken: () => process.env.DISCORD_BOT_TOKEN ?? "",
  publicKey: () => process.env.DISCORD_PUBLIC_KEY ?? "",
  guildId: () => process.env.DISCORD_GUILD_ID ?? "",
  brokerageRoleId: () => process.env.DISCORD_ROLE_BROKERAGE ?? "",
  stateSecret: () => process.env.VERIFY_STATE_SECRET ?? "",
  recheckSecret: () => process.env.RECHECK_SECRET ?? "",
  kvUrl: () => process.env.KV_REST_API_URL ?? "",
  kvToken: () => process.env.KV_REST_API_TOKEN ?? "",
};

// Server-side chain client: same public-first tiering as the app, plus the Origin
// header the public RPC's allowlist expects. Exported for the other Discord routes
// (sales sweep) so there is exactly one server-side client configuration.
export const serverClient = createPublicClient({
  chain: activeChain,
  transport: fallback(
    RPC_PUBLIC_FIRST.map((url) =>
      http(url, { fetchOptions: { headers: { Origin: "https://www.coattail.cash" } } }),
    ),
  ),
});

export async function brokerCount(address: `0x${string}`): Promise<number> {
  const bal = await serverClient.readContract({
    address: ADDR.broker, abi: brokerAbi, functionName: "balanceOf", args: [address],
  });
  return Number(bal);
}

// ── one-time state token: HMAC(userId.guildId.exp) ──────────────────────────
function hmac(payload: string): string {
  return createHmac("sha256", env.stateSecret()).update(payload).digest("base64url");
}

export function makeState(userId: string, guildId: string): string {
  const exp = Date.now() + STATE_TTL_MS;
  const payload = `${userId}.${guildId}.${exp}`;
  return `${Buffer.from(payload).toString("base64url")}.${hmac(payload)}`;
}

export function parseState(state: string): { userId: string; guildId: string } | null {
  const [body, mac] = state.split(".", 2).length === 2 ? state.split(/\.(?=[^.]+$)/) : [null, null];
  if (!body || !mac) return null;
  const payload = Buffer.from(body, "base64url").toString();
  const expect = hmac(payload);
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [userId, guildId, exp] = payload.split(".");
  if (!userId || !guildId || Number(exp) < Date.now()) return null;
  return { userId, guildId };
}

// ── Discord REST ────────────────────────────────────────────────────────────
async function discord(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${env.botToken()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function setBrokerageRole(guildId: string, userId: string, grant: boolean): Promise<boolean> {
  const path = `/guilds/${guildId}/members/${userId}/roles/${env.brokerageRoleId()}`;
  const res = await discord(path, { method: grant ? "PUT" : "DELETE" });
  return res.ok || res.status === 204;
}

// ── KV (Upstash REST protocol) ──────────────────────────────────────────────
async function kv(cmd: (string | number)[]): Promise<{ result?: unknown } | null> {
  if (!env.kvUrl() || !env.kvToken()) return null;
  const res = await fetch(env.kvUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${env.kvToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) return null;
  return res.json();
}

/** Plain string get/set for other Discord features (e.g. the sales sweep cursor). */
export async function kvGet(k: string): Promise<string | null> {
  const res = await kv(["GET", k]);
  const v = res?.result;
  return typeof v === "string" && v ? v : null;
}

export async function kvSet(k: string, v: string): Promise<void> {
  await kv(["SET", k, v]);
}

const key = (guildId: string, userId: string) => `verify:${guildId}:${userId}`;
const claimKey = (guildId: string, address: string) => `claim:${guildId}:${address.toLowerCase()}`;

export async function kvRemember(guildId: string, userId: string, address: string): Promise<void> {
  await kv(["SET", key(guildId, userId), address]);
  await kv(["SET", claimKey(guildId, address), userId]);
}

export async function kvForget(guildId: string, userId: string, address?: string): Promise<void> {
  await kv(["DEL", key(guildId, userId)]);
  if (address) await kv(["DEL", claimKey(guildId, address)]);
}

/** Address-only verification's one real lock: the first Discord account to claim an
 *  address owns the claim; anyone else gets refused. Returns the current claimant's
 *  user id, or null when unclaimed / KV unavailable. */
export async function kvClaimedBy(guildId: string, address: string): Promise<string | null> {
  const res = await kv(["GET", claimKey(guildId, address)]);
  const v = res?.result;
  return typeof v === "string" && v ? v : null;
}

export async function kvScan(cursor: string): Promise<{ cursor: string; entries: { guildId: string; userId: string; address: string }[] } | null> {
  const res = await kv(["SCAN", cursor, "MATCH", "verify:*", "COUNT", 100]);
  const r = res?.result as [string, string[]] | undefined;
  if (!r) return null;
  const [next, keys] = r;
  const entries: { guildId: string; userId: string; address: string }[] = [];
  for (const k of keys) {
    const [, guildId, userId] = k.split(":");
    const got = await kv(["GET", k]);
    const address = got?.result as string | undefined;
    if (guildId && userId && address) entries.push({ guildId, userId, address });
  }
  return { cursor: next, entries };
}
