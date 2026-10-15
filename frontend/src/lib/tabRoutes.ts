import type { TabId } from "@/components/Tabs";
import { TRADE_TAB_ENABLED } from "./floor";
import { DESK_TAB_ENABLED } from "./desk";

// Every tab is its own address: coattail.cash/trade, /activate, /feed... (home is "/").
// The app used to select tabs with a #fragment; old /#tab links still land on the right tab
// and are rewritten to the clean address (AppShell).

/** The tabs this build serves, in nav order. */
export function routableTabs(): TabId[] {
  return [
    "home",
    ...(TRADE_TAB_ENABLED ? (["trade"] as const) : []),
    ...(DESK_TAB_ENABLED ? (["desk"] as const) : []),
    "activate",
    "feed",
    "leaders",
    "stats",
    "roadmap",
    "docs",
  ];
}

export function isRoutableTab(t: string): t is TabId {
  return (routableTabs() as string[]).includes(t);
}

/** The address of a tab. */
export const tabPath = (t: TabId) => (t === "home" ? "/" : `/${t}`);
