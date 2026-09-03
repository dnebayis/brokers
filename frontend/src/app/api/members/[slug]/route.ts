import { NextResponse } from "next/server";
import { loadMembers, MEMBERS_REVALIDATE } from "@/lib/members";

// One member's record: summary plus every filing of theirs in the basket window.
export const revalidate = MEMBERS_REVALIDATE;

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const data = await loadMembers();
  if (!data) return NextResponse.json({ ok: false, error: "members unavailable" }, { status: 502 });
  const member = data.members.find((m) => m.slug === slug);
  if (!member) return NextResponse.json({ ok: false, error: "no filings for this member in the window" }, { status: 404 });
  return NextResponse.json({ ok: true, generatedAt: data.generatedAt, windowDays: data.windowDays, member });
}
