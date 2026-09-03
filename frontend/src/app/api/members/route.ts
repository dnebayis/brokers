import { NextResponse } from "next/server";
import { loadMembers } from "@/lib/members";

// Member index: every member with filings in the basket window, summary only (no rows),
// sorted by disclosed buying.
export const revalidate = 600; // must be a literal for Next; keep in step with MEMBERS_REVALIDATE

export async function GET(req: Request) {
  const top = Number(new URL(req.url).searchParams.get("top") || "0");
  const data = await loadMembers();
  if (!data) return NextResponse.json({ ok: false, error: "members unavailable" }, { status: 502 });
  const members = data.members.map(({ rows: _rows, ...m }) => { void _rows; return m; });
  return NextResponse.json({ ok: true, generatedAt: data.generatedAt, windowDays: data.windowDays, members: top > 0 ? members.slice(0, top) : members });
}
