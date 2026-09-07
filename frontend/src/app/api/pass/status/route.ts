import { NextResponse } from "next/server";
import { passkitConfigured, passkitUpdatesConfigured } from "@/lib/passkit/config";

// Lets the site decide whether to show "Add to Apple Wallet" at all. No secrets, just flags.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { apple: passkitConfigured(), updates: passkitUpdatesConfigured() },
    { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
  );
}
