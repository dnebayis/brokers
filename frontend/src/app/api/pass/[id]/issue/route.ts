import { NextResponse } from "next/server";
import { isAddress, type Address, type Hex } from "viem";
import { activeChain } from "@/lib/chains";
import { publicClient } from "@/lib/client";
import { passkitConfig } from "@/lib/passkit/config";
import { readBrokerPassState } from "@/lib/passkit/chain";
import { downloadToken, issueExpiryValid, issueMessage } from "@/lib/passkit/token";

// Step one of "Add to Apple Wallet": the holder signs a message naming the Broker, their
// wallet, the chain and an expiry; we check the signature (EOA or ERC-1271 smart account),
// check ownership on chain right now, and answer with a short-lived download link. The link
// is opened by navigation because that is the only way iOS Safari offers "Add to Wallet".
export const dynamic = "force-dynamic";

type Body = { address?: string; signature?: string; expiresAt?: string };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const cfg = passkitConfig();
  if (!cfg) return NextResponse.json({ error: "wallet passes are not configured" }, { status: 503 });

  const { id: idText } = await params;
  const id = Number(idText);
  if (!Number.isInteger(id) || id < 1 || id > 100_000) return NextResponse.json({ error: "bad broker id" }, { status: 400 });

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "json body expected" }, { status: 400 });
  }
  const address = (body.address ?? "").trim();
  const signature = (body.signature ?? "").trim();
  const expiresAt = (body.expiresAt ?? "").trim();
  if (!isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) return NextResponse.json({ error: "bad signature" }, { status: 400 });
  if (!issueExpiryValid(expiresAt)) return NextResponse.json({ error: "request expired, try again" }, { status: 400 });

  const message = issueMessage({ id, address, chainId: activeChain.id, expiresAt });
  let valid = false;
  try {
    valid = await publicClient.verifyMessage({ address: address as Address, message, signature: signature as Hex });
  } catch (err) {
    console.warn("pass issue: verify failed:", String(err));
  }
  if (!valid) return NextResponse.json({ error: "signature does not match" }, { status: 401 });

  let live;
  try {
    live = await readBrokerPassState(id);
  } catch (err) {
    console.warn("pass issue: chain read failed:", String(err));
    return NextResponse.json({ error: "chain read failed, retry shortly" }, { status: 502 });
  }
  if (!live) return NextResponse.json({ error: `Broker #${id} does not exist` }, { status: 404 });
  if (live.owner.toLowerCase() !== address.toLowerCase()) {
    return NextResponse.json({ error: "that wallet does not own this Broker" }, { status: 403 });
  }

  const exp = Math.floor(Date.now() / 1000) + 15 * 60;
  const t = downloadToken(cfg.authSecret, id, address, exp);
  const url = `${cfg.siteOrigin}/api/pass/${id}/download?t=${encodeURIComponent(t)}`;
  return NextResponse.json({ url, expiresAt: new Date(exp * 1000).toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
