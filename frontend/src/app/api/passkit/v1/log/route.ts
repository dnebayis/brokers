import { NextResponse } from "next/server";
import { kvConfigured } from "@/lib/kv";
import { appendDeviceLog } from "@/lib/passkit/store";

// PassKit web service: phones post error strings here when a pass update fails. Kept (last
// 20 lines) so the push sweep can show them; that is the only window Apple gives into what
// the phone thought of our pass.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { logs?: unknown };
    const logs = Array.isArray(body.logs) ? body.logs.slice(0, 20).map(String) : [];
    if (logs.length) {
      console.warn("passkit device log:", logs.join(" | ").slice(0, 2000));
      if (kvConfigured()) await appendDeviceLog(logs).catch(() => undefined);
    }
  } catch {
    /* ignore malformed */
  }
  return new NextResponse(null, { status: 200 });
}
