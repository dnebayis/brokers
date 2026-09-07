import { NextResponse } from "next/server";

// PassKit web service: phones post error strings here when a pass update fails. Logged, that's all.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { logs?: unknown };
    const logs = Array.isArray(body.logs) ? body.logs.slice(0, 20).map(String) : [];
    if (logs.length) console.warn("passkit device log:", logs.join(" | ").slice(0, 2000));
  } catch {
    /* ignore malformed */
  }
  return new NextResponse(null, { status: 200 });
}
