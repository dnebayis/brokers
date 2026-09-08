import { NextResponse } from "next/server";
import { passkitConfig } from "@/lib/passkit/config";
import { authorizedRecord } from "@/lib/passkit/auth";
import { refreshPass, PKPASS_MIME } from "@/lib/passkit/build";
import { kvConfigured } from "@/lib/kv";
import { noteFetch } from "@/lib/passkit/store";

// PassKit web service: the phone fetches the latest version of a pass it holds. Honors
// If-Modified-Since with 304 so an unchanged card costs nothing to check.
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ passTypeId: string; serial: string }> }) {
  const cfg = passkitConfig();
  if (!cfg || !kvConfigured()) return new NextResponse(null, { status: 503 });
  const { passTypeId, serial } = await params;
  const record = await authorizedRecord(cfg, request, passTypeId, serial);
  if (!record) {
    const id = Number(serial);
    if (Number.isInteger(id) && id > 0) await noteFetch(id, 401).catch(() => undefined); // diagnostics
    return new NextResponse(null, { status: 401 });
  }

  try {
    const built = await refreshPass(cfg, record);
    if (built === "no-broker") return new NextResponse(null, { status: 404 });
    const modified = new Date(built.record.updatedAt * 1000);
    const since = Date.parse(request.headers.get("if-modified-since") ?? "");
    const unchanged = Number.isFinite(since) && since >= modified.getTime() - 999;
    await noteFetch(record.id, unchanged ? 304 : 200).catch(() => undefined); // diagnostics only
    if (unchanged) {
      return new NextResponse(null, { status: 304, headers: { "Last-Modified": modified.toUTCString() } });
    }
    return new NextResponse(new Uint8Array(built.buffer), {
      status: 200,
      headers: { "Content-Type": PKPASS_MIME, "Last-Modified": modified.toUTCString(), "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.warn("passkit pass fetch failed:", String(err));
    return new NextResponse(null, { status: 500 });
  }
}
