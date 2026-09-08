import { kvDel, kvGet, kvGetJson, kvSAdd, kvSMembers, kvSRem, kvSet, kvSetJson } from "@/lib/kv";

// What the pass layer remembers per Broker, and which phones asked to be told about changes.
// Keys:
//   wp:pass:<id>        PassRecord (the issued-to owner and the last state the pass showed)
//   wp:reg:<id>         set of device library ids registered for this Broker's pass
//   wp:dev:<device>     set of serials (Broker ids) that device holds
//   wp:push:<device>    the device's APNs push token
//   wp:serials          set of every Broker id with at least one registration
//   wp:cursor           push-sweep cursor (last serial processed)

export type PassRecord = {
  id: number;
  owner: string; // lowercase, the owner the pass was issued to
  issuedAt: number; // unix seconds
  updatedAt: number; // unix seconds; bumps whenever the card's content changed
  active: boolean;
  /** raw units per token symbol (wallet + claimable), so payouts are detected as unit growth,
   *  never as a price move */
  units: Record<string, string>;
  balanceUsd: number | null;
  claimableUsd: number | null;
  lastPayoutUsd: number | null;
  voided: boolean; // live owner differs from `owner`; the card shows SOLD
};

const K = {
  pass: (id: number) => `wp:pass:${id}`,
  reg: (id: number) => `wp:reg:${id}`,
  dev: (device: string) => `wp:dev:${device}`,
  push: (device: string) => `wp:push:${device}`,
  serials: "wp:serials",
  cursor: "wp:cursor",
  // diagnostics, so the sweep can tell whether a phone actually fetched after a push
  fetch: (id: number) => `wp:fetch:${id}`, // {at, status} of the last web-service GET
  regAt: (id: number) => `wp:regat:${id}`, // unix seconds of the last registration
  log: "wp:log", // last lines the phones posted to /v1/log
};

export type FetchNote = { at: number; status: number };
export type DeviceLogLine = { at: number; line: string };

export const getPass = (id: number) => kvGetJson<PassRecord>(K.pass(id));
export const putPass = (r: PassRecord) => kvSetJson(K.pass(r.id), r);

export async function register(id: number, device: string, pushToken: string): Promise<"created" | "exists"> {
  const existing = await kvSMembers(K.reg(id));
  const already = existing.includes(device);
  await Promise.all([
    kvSAdd(K.reg(id), device),
    kvSAdd(K.dev(device), String(id)),
    kvSet(K.push(device), pushToken),
    kvSAdd(K.serials, String(id)),
    kvSet(K.regAt(id), String(Math.floor(Date.now() / 1000))),
  ]);
  return already ? "exists" : "created";
}

export const noteFetch = (id: number, status: number) =>
  kvSetJson(K.fetch(id), { at: Math.floor(Date.now() / 1000), status } satisfies FetchNote);
export const lastFetch = (id: number) => kvGetJson<FetchNote>(K.fetch(id));
export const registeredAt = async (id: number): Promise<number | null> => {
  const v = await kvGet(K.regAt(id));
  return v ? Number(v) : null;
};

/** Keep the last 20 lines phones posted to the log endpoint (they only post on failures). */
export async function appendDeviceLog(lines: string[]): Promise<void> {
  const at = Math.floor(Date.now() / 1000);
  const current = (await kvGetJson<DeviceLogLine[]>(K.log)) ?? [];
  const next = [...current, ...lines.map((line) => ({ at, line: line.slice(0, 300) }))].slice(-20);
  await kvSetJson(K.log, next);
}
export const deviceLog = async (): Promise<DeviceLogLine[]> => (await kvGetJson<DeviceLogLine[]>(K.log)) ?? [];

export async function unregister(id: number, device: string): Promise<void> {
  await Promise.all([kvSRem(K.reg(id), device), kvSRem(K.dev(device), String(id))]);
  const left = await kvSMembers(K.dev(device));
  if (left.length === 0) await kvDel(K.push(device));
  const regs = await kvSMembers(K.reg(id));
  if (regs.length === 0) await kvSRem(K.serials, String(id));
}

export const devicesFor = (id: number) => kvSMembers(K.reg(id));
export const serialsFor = (device: string) => kvSMembers(K.dev(device));
export const pushTokenFor = (device: string) => kvGet(K.push(device));
export const allSerials = () => kvSMembers(K.serials);
export const getCursor = () => kvGet(K.cursor);
export const setCursor = (v: string) => kvSet(K.cursor, v);

/** Drop a device whose push token APNs reports as gone (410). */
export async function forgetDevice(device: string): Promise<void> {
  const serials = await kvSMembers(K.dev(device));
  await Promise.all(serials.map((s) => unregister(Number(s), device)));
  await kvDel(K.push(device));
}
