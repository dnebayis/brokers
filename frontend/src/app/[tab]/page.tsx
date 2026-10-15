import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { isRoutableTab, routableTabs } from "@/lib/tabRoutes";

// coattail.cash/trade, /activate, /feed...: the app with that tab open. Only the tabs this
// build serves exist; anything else is a 404 (fixed folders like /terms win over this).
export const dynamicParams = false;

export function generateStaticParams() {
  return routableTabs()
    .filter((t) => t !== "home")
    .map((tab) => ({ tab }));
}

export default async function TabPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  if (tab === "home" || !isRoutableTab(tab)) notFound();
  return <AppShell initialTab={tab} />;
}
