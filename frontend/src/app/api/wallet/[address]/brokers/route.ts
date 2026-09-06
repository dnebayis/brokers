import { ADDR } from "@/lib/config";
import { activeChain } from "@/lib/chains";
import { walletBrokers } from "@/lib/brokerApi";
import { cacheFor, publicJson, publicOptions } from "@/lib/publicApi";

// Public, keyless: every Broker a wallet currently holds, with active status and each
// Broker's 6551 wallet. Backs the G's campaign tooling and any holder dashboard.
// CDN-cached for an hour by default (`?ttl=60` for a live page); CORS-open so browser code
// can call it.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;

  try {
    const brokers = await walletBrokers(address);
    if (brokers === null) {
      return publicJson({ error: "address must be a checksummed or lowercase 0x address" }, 400);
    }
    return publicJson({
      chainId: activeChain.id,
      contracts: { broker: ADDR.broker, booster: ADDR.booster },
      address,
      count: brokers.length,
      brokers,
      asOf: new Date().toISOString(),
    }, 200, cacheFor(request));
  } catch (err) {
    console.warn("wallet api: chain read failed:", String(err));
    return publicJson({ error: "chain read failed, retry shortly" }, 502);
  }
}

export function OPTIONS() {
  return publicOptions();
}
