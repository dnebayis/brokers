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
};

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
  ]);
  return already ? "exists" : "created";
}

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
