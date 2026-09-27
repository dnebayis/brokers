import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DeskLabRoot } from "@/components/desklab/DeskLab";

export const metadata: Metadata = {
  title: "Desk lab · Coattail Brokers",
  robots: { index: false, follow: false },
};

// Local-only working surface for the Desk contracts (desk/script/local_env.py). The flag is
// never set on Vercel, so production answers 404 here.
export default function DeskLabPage() {
  if (process.env.NEXT_PUBLIC_DESK_LAB !== "1") notFound();
  return <DeskLabRoot />;
}
