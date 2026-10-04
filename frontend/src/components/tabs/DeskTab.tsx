"use client";

import { DeskApp } from "@/components/desk/DeskApp";
import { publicClient } from "@/lib/client";
import { DESK_CONFIG } from "@/lib/desk";

// The site's Desk tab: the shared Desk component on the site's own wallet and read client.
export function DeskTab() {
  if (!DESK_CONFIG) return null;
  return <DeskApp cfg={DESK_CONFIG} client={publicClient} variant="site" pollMs={15_000} />;
}
