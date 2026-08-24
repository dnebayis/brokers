import { NextResponse } from "next/server";
import { ADDR } from "@/lib/config";
import { activeChain } from "@/lib/chains";
import { walletBrokers } from "@/lib/brokerApi";

// Public, keyless: every Broker a wallet currently holds, with active status and each
// Broker's 6551 wallet. Backs the G's campaign tooling and any holder dashboard.
// CDN-cached for an hour — transfers show up on the next revalidation.
const CACHE = "public, s-maxage=3600, stale-while-revalidate=600";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;

  try {
    const brokers = await walletBrokers(address);
    if (brokers === null) {
      return NextResponse.json({ error: "address must be a checksummed or lowercase 0x address" }, { status: 400 });
    }
    return NextResponse.json(
      {
        chainId: activeChain.id,
        contracts: { broker: ADDR.broker, booster: ADDR.booster },
        address,
        count: brokers.length,
        brokers,
        asOf: new Date().toISOString(),
      },
      { headers: { "Cache-Control": CACHE } },
    );
  } catch (err) {
    console.warn("wallet api: chain read failed:", String(err));
    return NextResponse.json({ error: "chain read failed, retry shortly" }, { status: 502 });
  }
}
