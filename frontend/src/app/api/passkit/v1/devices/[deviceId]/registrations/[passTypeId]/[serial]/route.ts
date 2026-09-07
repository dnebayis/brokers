import { NextResponse } from "next/server";
import { passkitConfig } from "@/lib/passkit/config";
import { authorizedRecord } from "@/lib/passkit/auth";
import { register, unregister } from "@/lib/passkit/store";
import { kvConfigured } from "@/lib/kv";

// PassKit web service: a phone registers (POST) or unregisters (DELETE) for push updates on
// one pass. Apple's contract: 201 created / 200 already registered / 401 bad token.
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ deviceId: string; passTypeId: string; serial: string }> };

export async function POST(request: Request, { params }: Ctx) {
  const cfg = passkitConfig();
  if (!cfg || !kvConfigured()) return new NextResponse(null, { status: 503 });
  const { deviceId, passTypeId, serial } = await params;
  const record = await authorizedRecord(cfg, request, passTypeId, serial);
  if (!record) return new NextResponse(null, { status: 401 });
  let pushToken = "";
  try {
    pushToken = String(((await request.json()) as { pushToken?: string }).pushToken ?? "");
  } catch {
    /* fallthrough */
  }
  if (!/^[0-9a-f]{32,200}$/i.test(pushToken)) return new NextResponse(null, { status: 400 });
  try {
    const outcome = await register(record.id, deviceId, pushToken);
    return new NextResponse(null, { status: outcome === "created" ? 201 : 200 });
  } catch (err) {
    console.warn("passkit register failed:", String(err));
    return new NextResponse(null, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  const cfg = passkitConfig();
  if (!cfg || !kvConfigured()) return new NextResponse(null, { status: 503 });
  const { deviceId, passTypeId, serial } = await params;
  const record = await authorizedRecord(cfg, request, passTypeId, serial);
  if (!record) return new NextResponse(null, { status: 401 });
  try {
    await unregister(record.id, deviceId);
    return new NextResponse(null, { status: 200 });
  } catch (err) {
    console.warn("passkit unregister failed:", String(err));
    return new NextResponse(null, { status: 500 });
  }
}
