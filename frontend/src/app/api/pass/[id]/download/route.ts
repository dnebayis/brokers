import { NextResponse } from "next/server";
import { passkitConfig } from "@/lib/passkit/config";
import { issuePass, PKPASS_MIME } from "@/lib/passkit/build";
import { parseDownloadToken } from "@/lib/passkit/token";

// Step two: the signed link from /issue. Ownership is re-checked here too, so a link minted
// seconds before a sale cannot hand the buyer's Broker pass to the seller.
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const cfg = passkitConfig();
  if (!cfg) return NextResponse.json({ error: "wallet passes are not configured" }, { status: 503 });
  const { id: idText } = await params;
  const id = Number(idText);
  const t = new URL(request.url).searchParams.get("t") ?? "";
  const parsed = parseDownloadToken(cfg.authSecret, t);
  if (!parsed || parsed.id !== id) return NextResponse.json({ error: "link expired or invalid, add the pass again" }, { status: 401 });

  try {
    const built = await issuePass(cfg, id, parsed.owner);
    if (built === "no-broker") return NextResponse.json({ error: "no such Broker" }, { status: 404 });
    if (built === "not-owner") return NextResponse.json({ error: "this Broker changed hands" }, { status: 409 });
    return new NextResponse(new Uint8Array(built.buffer), {
      status: 200,
      headers: {
        "Content-Type": PKPASS_MIME,
        "Content-Disposition": `attachment; filename="coattail-broker-${id}.pkpass"`,
        "Cache-Control": "no-store",
        "Last-Modified": new Date(built.record.updatedAt * 1000).toUTCString(),
      },
    });
  } catch (err) {
    console.warn("pass download failed:", String(err));
    return NextResponse.json({ error: "could not build the pass, retry shortly" }, { status: 502 });
  }
}
