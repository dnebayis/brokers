// Completes a Discord holder verification, address-only (owner's decision — no wallet
// connection, no signature): checks the one-time state token, the pasted address's
// on-chain Broker balance, and the first-claim lock (one address can only ever verify
// one Discord account), then grants the holder role and remembers the pairing for the
// daily re-check.

import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import {
  parseState, brokerCount, setBrokerageRole, kvRemember, kvClaimedBy,
} from "@/lib/discordVerify";

export async function POST(request: Request) {
  let payload: { state?: string; address?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  const { state, address } = payload;
  if (!state || !address) {
    return NextResponse.json({ ok: false, error: "missing fields" }, { status: 400 });
  }
  if (!isAddress(address)) {
    return NextResponse.json({ ok: false, error: "that is not a valid wallet address" }, { status: 400 });
  }
  const wallet = getAddress(address);

  const parsed = parseState(state);
  if (!parsed) {
    return NextResponse.json(
      { ok: false, error: "link expired — run /verify in Discord again" }, { status: 400 });
  }

  // First-claim lock: an address that verified once belongs to that Discord account.
  const claimant = await kvClaimedBy(parsed.guildId, wallet);
  if (claimant && claimant !== parsed.userId) {
    return NextResponse.json(
      { ok: false, error: "this address is already verified by another member" }, { status: 409 });
  }

  let brokers: number;
  try {
    brokers = await brokerCount(wallet);
  } catch {
    return NextResponse.json(
      { ok: false, error: "chain read failed — try again in a minute" }, { status: 502 });
  }

  if (brokers === 0) {
    return NextResponse.json({ ok: false, brokers: 0, error: "no Brokers in this wallet" });
  }

  const granted = await setBrokerageRole(parsed.guildId, parsed.userId, true);
  if (!granted) {
    return NextResponse.json(
      { ok: false, brokers, error: "role assignment failed — is the bot role above Brokerage?" },
      { status: 502 });
  }
  await kvRemember(parsed.guildId, parsed.userId, wallet);
  return NextResponse.json({ ok: true, brokers });
}
