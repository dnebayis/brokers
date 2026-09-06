import { ADDR } from "@/lib/config";
import { activeChain } from "@/lib/chains";
import { walletBrokers } from "@/lib/brokerApi";
import { cacheFor, publicJson, publicOptions } from "@/lib/publicApi";

// Public, keyless: every Broker a wallet currently holds, with active status and each
// Broker's 6551 wallet. Backs the G's campaign tooling and any holder dashboard.
// CDN-cached for an hour by default (`?ttl=60` for a live page); CORS-open so browser code
// can call it.
//
// The last complete roster per wallet is kept in this process. When the chain read fails
// (the public RPC drops chunks under load) the answer is that roster, marked `stale` and
// sent uncached, rather than a 502: a partner's dashboard polling this endpoint should see
// the desk as it was a few minutes ago, never an error page. A wallet nobody has read
// successfully yet still gets the 502.
type Roster = Awaited<ReturnType<typeof walletBrokers>>;
const lastGood = new Map<string, { brokers: NonNullable<Roster>; asOf: string }>();
const STALE_MAX_MS = 6 * 60 * 60_000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  const key = address.toLowerCase();
  const body = (brokers: NonNullable<Roster>, asOf: string, stale: boolean) => ({
    chainId: activeChain.id,
    contracts: { broker: ADDR.broker, booster: ADDR.booster },
    address,
    count: brokers.length,
    brokers,
    asOf,
    ...(stale ? { stale: true } : {}),
  });

  try {
    const brokers = await walletBrokers(address);
    if (brokers === null) {
      return publicJson({ error: "address must be a checksummed or lowercase 0x address" }, 400);
    }
    const asOf = new Date().toISOString();
    lastGood.set(key, { brokers, asOf });
    return publicJson(body(brokers, asOf, false), 200, cacheFor(request));
  } catch (err) {
    console.warn("wallet api: chain read failed:", String(err));
    const prev = lastGood.get(key);
    if (prev && Date.now() - Date.parse(prev.asOf) < STALE_MAX_MS) {
      return publicJson(body(prev.brokers, prev.asOf, true), 200, "no-store");
    }
    return publicJson({ error: "chain read failed, retry shortly" }, 502);
  }
}

export function OPTIONS() {
  return publicOptions();
}
