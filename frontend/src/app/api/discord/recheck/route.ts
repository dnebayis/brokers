// Daily sweep: re-reads every verified wallet's Broker balance and strips the holder
// role from wallets that sold out. Driven by a GitHub Actions cron with a bearer
// secret; processes one KV SCAN page per call and returns the next cursor, so the
// caller loops until cursor is "0".

import { NextResponse } from "next/server";
import { env, kvScan, kvForget, brokerCount, setBrokerageRole } from "@/lib/discordVerify";

export async function GET(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (!env.recheckSecret() || auth !== `Bearer ${env.recheckSecret()}`) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const cursor = new URL(request.url).searchParams.get("cursor") ?? "0";
  const page = await kvScan(cursor);
  if (!page) {
    return NextResponse.json({ ok: false, error: "kv not configured" }, { status: 501 });
  }

  let kept = 0, revoked = 0, errors = 0;
  for (const { guildId, userId, address } of page.entries) {
    try {
      if (await brokerCount(address as `0x${string}`) > 0) {
        kept += 1;
      } else {
        await setBrokerageRole(guildId, userId, false);
        await kvForget(guildId, userId, address);
        revoked += 1;
      }
    } catch {
      errors += 1; // chain hiccup: keep the role, next sweep retries
    }
  }
  return NextResponse.json({ ok: true, cursor: page.cursor, kept, revoked, errors });
}
