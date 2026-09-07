// Upstash-style REST KV (the same store the Discord sales cursor lives in), generic commands.
// Every helper throws when KV is configured but unreachable, so callers can tell "no data"
// from "the store is down" and never mistake an outage for an empty answer.

export function kvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function kv(cmd: (string | number)[]): Promise<unknown> {
  if (!kvConfigured()) throw new Error("KV not configured");
  const res = await fetch(process.env.KV_REST_API_URL as string, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`kv ${cmd[0]} failed: ${res.status}`);
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (data.error) throw new Error(`kv ${cmd[0]}: ${data.error}`);
  return data.result;
}

export const kvGet = async (k: string): Promise<string | null> => {
  const v = await kv(["GET", k]);
  return typeof v === "string" ? v : null;
};
export const kvSet = async (k: string, v: string, ttlSec?: number): Promise<void> => {
  await (ttlSec ? kv(["SET", k, v, "EX", ttlSec]) : kv(["SET", k, v]));
};
export const kvDel = async (k: string): Promise<void> => {
  await kv(["DEL", k]);
};
export const kvSAdd = async (k: string, ...members: string[]): Promise<void> => {
  if (members.length) await kv(["SADD", k, ...members]);
};
export const kvSRem = async (k: string, ...members: string[]): Promise<void> => {
  if (members.length) await kv(["SREM", k, ...members]);
};
export const kvSMembers = async (k: string): Promise<string[]> => {
  const v = await kv(["SMEMBERS", k]);
  return Array.isArray(v) ? v.map(String) : [];
};
export const kvSIsMember = async (k: string, m: string): Promise<boolean> => {
  const v = await kv(["SISMEMBER", k, m]);
  return Number(v) === 1;
};

export async function kvGetJson<T>(k: string): Promise<T | null> {
  const raw = await kvGet(k);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
export const kvSetJson = (k: string, v: unknown, ttlSec?: number) => kvSet(k, JSON.stringify(v), ttlSec);
