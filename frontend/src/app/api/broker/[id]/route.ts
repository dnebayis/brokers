import { ADDR } from "@/lib/config";
import { activeChain } from "@/lib/chains";
import { brokerSnapshot } from "@/lib/brokerApi";
import { publicJson, publicOptions } from "@/lib/publicApi";

// Public, keyless Broker lookup: owner, 6551 wallet, active status, claimable salary
// and current wallet holdings — everything an integrator (campaign tooling, dashboards)
// needs without touching ABIs. CDN-cached for an hour; the chain is the source of truth
// for anything more real-time.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idText } = await params;
  const id = Number(idText);
  if (!Number.isInteger(id) || id < 1 || id > 100_000) {
    return publicJson({ error: "id must be a positive integer token ID" }, 400);
  }

  try {
    const snapshot = await brokerSnapshot(id);
    if (!snapshot) {
      return publicJson({ error: `Broker #${id} does not exist` }, 404);
    }
    return publicJson({
      chainId: activeChain.id,
      contracts: { broker: ADDR.broker, booster: ADDR.booster, coat: ADDR.coat },
      broker: snapshot,
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("broker api: chain read failed:", String(err));
    return publicJson({ error: "chain read failed, retry shortly" }, 502);
  }
}

export function OPTIONS() {
  return publicOptions();
}
