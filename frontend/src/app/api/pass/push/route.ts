import { NextResponse } from "next/server";
import { passkitConfig, pushSecret } from "@/lib/passkit/config";
import { readBrokerPassState } from "@/lib/passkit/chain";
import { refreshRecord } from "@/lib/passkit/build";
import { allSerials, deviceLog, devicesFor, forgetDevice, getCursor, getPass, lastFetch, pushTokenFor, registeredAt, setCursor } from "@/lib/passkit/store";
import { pushDefaults, pushPassUpdates, type PushType } from "@/lib/passkit/apns";
import { kvConfigured } from "@/lib/kv";

// The push sweep: walks every Broker that has a registered pass, compares the chain with what
// the card last showed, and pings the phones whose card changed (payout landed, switched
// on/off, sold). Poked every few minutes by the Cloudflare heartbeat; idempotent, cursor-
// resumed so one run only ever does a slice, and a chain hiccup on one Broker skips just it.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LIMIT = Math.max(5, Math.min(200, Number(process.env.PASSKIT_SWEEP_LIMIT ?? "40") || 40));
const BUDGET_MS = 25_000;

async function sweep(request: Request): Promise<NextResponse> {
  const secret = pushSecret();
  const auth = request.headers.get("authorization") ?? "";
  if (!secret || auth !== `Bearer ${secret}`) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const cfg = passkitConfig();
  if (!cfg || !kvConfigured()) return NextResponse.json({ ok: false, error: "passes or KV not configured" }, { status: 503 });

  const started = Date.now();
  const now = Math.floor(started / 1000);
  const serials = (await allSerials()).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  if (serials.length === 0) return NextResponse.json({ ok: true, registered: 0, checked: 0, changed: 0, pushed: 0 });

  const cursor = Number((await getCursor()) ?? "0") || 0;
  let start = serials.findIndex((s) => s > cursor);
  if (start < 0) start = 0; // wrapped
  const slice = serials.slice(start, start + LIMIT);

  // ?force=<id>: ping that pass's phones even if nothing changed (diagnostics: does a push
  // make the phone fetch? the fetch note below answers). Never changes the record.
  const forceRaw = new URL(request.url).searchParams.get("force") ?? "";
  const [forceIdRaw, forceTypeRaw] = forceRaw.split(":");
  const force = Number(forceIdRaw) || 0;
  const forceType: PushType | undefined = forceTypeRaw === "alert" || forceTypeRaw === "background" ? forceTypeRaw : undefined;
  const pushOptions = forceType ? { pushType: forceType, priority: forceType === "alert" ? (10 as const) : (5 as const) } : {};

  const touchedDevices = new Set<string>();
  const changed: { id: number; reasons: string[] }[] = [];
  const failed: number[] = [];
  const passes: { id: number; updatedAt: number; registeredAt: number | null; lastFetch: { at: number; status: number } | null; devices: number }[] = [];
  let last = cursor;
  for (const id of slice) {
    if (Date.now() - started > BUDGET_MS) break;
    last = id;
    try {
      const record = await getPass(id);
      if (!record) continue;
      const live = await readBrokerPassState(id);
      if (!live) continue;
      const r = await refreshRecord(record, live, now);
      const devices = await devicesFor(id);
      passes.push({ id, updatedAt: r.record.updatedAt, registeredAt: await registeredAt(id), lastFetch: await lastFetch(id), devices: devices.length });
      if (!r.changed && id !== force) continue;
      if (r.changed) changed.push({ id, reasons: r.reasons });
      for (const d of devices) touchedDevices.add(d);
    } catch (err) {
      failed.push(id);
      console.warn(`pass sweep: #${id} failed:`, String(err));
    }
  }
  const wrapped = start + slice.length >= serials.length;
  await setCursor(wrapped ? "0" : String(last));

  // one push per device, whatever the number of changed passes it holds
  const tokens = new Map<string, string>(); // token → device
  for (const d of touchedDevices) {
    const t = await pushTokenFor(d);
    if (t) tokens.set(t, d);
  }
  const results = await pushPassUpdates(
    [...tokens.keys()],
    { cert: cfg.signerCert, key: cfg.signerKey, passphrase: cfg.signerKeyPassphrase },
    cfg.passTypeId,
    pushOptions,
  );
  let pushed = 0;
  const pushErrors: string[] = [];
  for (const r of results) {
    if (r.status >= 200 && r.status < 300) pushed++;
    else if (r.gone) await forgetDevice(tokens.get(r.token) ?? "").catch(() => undefined);
    else pushErrors.push(`${r.status}:${(r.error ?? "").slice(0, 80)}`);
  }

  return NextResponse.json({
    ok: true,
    registered: serials.length,
    checked: slice.length,
    cursor: wrapped ? 0 : last,
    changed,
    failed,
    devices: touchedDevices.size,
    pushed,
    pushErrors: pushErrors.slice(0, 5),
    forced: force || undefined,
    push: { ...pushDefaults(), ...pushOptions },
    passes,
    deviceLog: (await deviceLog().catch(() => [])).slice(-10),
    ms: Date.now() - started,
  });
}

export const GET = sweep;
export const POST = sweep;
