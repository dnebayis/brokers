import { NextResponse } from "next/server";
import { ADDR } from "@/lib/config";
import { activeChain } from "@/lib/chains";
import { brokerSnapshot } from "@/lib/brokerApi";

// Public, keyless Broker lookup: owner, 6551 wallet, active status, claimable salary
// and current wallet holdings — everything an integrator (campaign tooling, dashboards)
// needs without touching ABIs. CDN-cached for an hour; the chain is the source of truth
// for anything more real-time.
const CACHE = "public, s-maxage=3600, stale-while-revalidate=600";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idText } = await params;
  const id = Number(idText);
  if (!Number.isInteger(id) || id < 1 || id > 100_000) {
    return NextResponse.json({ error: "id must be a positive integer token ID" }, { status: 400 });
  }

  try {
    const snapshot = await brokerSnapshot(id);
    if (!snapshot) {
      return NextResponse.json({ error: `Broker #${id} does not exist` }, { status: 404 });
    }
    return NextResponse.json(
      {
        chainId: activeChain.id,
        contracts: { broker: ADDR.broker, booster: ADDR.booster, coat: ADDR.coat },
        broker: snapshot,
        asOf: new Date().toISOString(),
      },
      { headers: { "Cache-Control": CACHE } },
    );
  } catch (err) {
    console.warn("broker api: chain read failed:", String(err));
    return NextResponse.json({ error: "chain read failed, retry shortly" }, { status: 502 });
  }
}
