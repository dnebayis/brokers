import { NextResponse } from "next/server";
import { passkitConfig } from "@/lib/passkit/config";
import { getPass, serialsFor } from "@/lib/passkit/store";
import { kvConfigured } from "@/lib/kv";

// PassKit web service: "which of my passes changed since <tag>?" Apple sends this after a
// push; the tag is whatever `lastUpdated` we returned last time (unix seconds here).
// No Authorization header on this call by design. 204 = nothing new.
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ deviceId: string; passTypeId: string }> }) {
  const cfg = passkitConfig();
  if (!cfg || !kvConfigured()) return new NextResponse(null, { status: 503 });
  const { deviceId, passTypeId } = await params;
  if (passTypeId !== cfg.passTypeId) return new NextResponse(null, { status: 404 });
  const since = Number(new URL(request.url).searchParams.get("passesUpdatedSince") ?? "0") || 0;
  try {
    const serials = await serialsFor(deviceId);
    if (serials.length === 0) return new NextResponse(null, { status: 404 });
    const records = await Promise.all(serials.map((s) => getPass(Number(s))));
    const changed = records.filter((r): r is NonNullable<typeof r> => !!r && r.updatedAt > since);
    if (changed.length === 0) return new NextResponse(null, { status: 204 });
    const lastUpdated = Math.max(...changed.map((r) => r.updatedAt));
    return NextResponse.json(
      { lastUpdated: String(lastUpdated), serialNumbers: changed.map((r) => String(r.id)) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.warn("passkit registrations failed:", String(err));
    return new NextResponse(null, { status: 500 });
  }
}
