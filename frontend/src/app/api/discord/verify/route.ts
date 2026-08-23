// Discord holder verification with a real ownership proof, no wallet connection:
// the member puts a one-time code in their OpenSea profile bio. Editing that bio
// requires signing in to OpenSea WITH the wallet, so finding the code there proves
// ownership — the signature happens on OpenSea's side, never ours.
//
// GET  ?state=&address=   -> the code to place in the bio
// POST {state, address}   -> checks the bio, the Broker balance, then grants the role.
// A bio-proven verification OVERRIDES any earlier claim on the address (the
// address-only era allowed hijacks; proof beats first-come).

import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import {
  parseState, brokerCount, setBrokerageRole, kvRemember, kvForget, kvClaimedBy,
  bioCode, openseaBio,
} from "@/lib/discordVerify";

function parseInputs(state?: string | null, address?: string | null) {
  if (!state || !address) return { error: "missing fields" };
  if (!isAddress(address)) return { error: "that is not a valid wallet address" };
  const parsed = parseState(state);
  if (!parsed) return { error: "link expired — run /verify in Discord again" };
  return { parsed, wallet: getAddress(address) };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const r = parseInputs(url.searchParams.get("state"), url.searchParams.get("address"));
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, code: bioCode(r.parsed.userId, r.wallet) });
}

export async function POST(request: Request) {
  let payload: { state?: string; address?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  const r = parseInputs(payload.state, payload.address);
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 400 });
  const { parsed, wallet } = r;

  // Ownership proof: the one-time code must be present in the wallet's OpenSea bio.
  const bio = await openseaBio(wallet);
  if (bio === null) {
    return NextResponse.json(
      { ok: false, error: "could not read the OpenSea profile — try again in a minute" },
      { status: 502 });
  }
  const code = bioCode(parsed.userId, wallet);
  if (!bio.toLowerCase().includes(code.toLowerCase())) {
    return NextResponse.json({
      ok: false,
      code,
      error: "code not found in the OpenSea bio yet — save it on your profile, wait a few seconds, and check again",
    });
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

  // Proof beats first-come: if another Discord account claimed this address in the
  // address-only era, the proven owner takes it over and the old claim loses the role.
  const claimant = await kvClaimedBy(parsed.guildId, wallet);
  if (claimant && claimant !== parsed.userId) {
    await setBrokerageRole(parsed.guildId, claimant, false);
    await kvForget(parsed.guildId, claimant, wallet);
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
