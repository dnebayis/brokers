"use client";

import { Icon } from "./ui/Icon";
import { TRADE_TAB_ENABLED } from "@/lib/floor";

export type TabId = "home" | "trade" | "activate" | "feed" | "leaders" | "roadmap" | "docs";

// Labels say what the page IS for the visitor, not what the protocol calls the
// action: "Activate" hid the fact that the tab is your whole portfolio.
const TABS: { id: TabId; label: string; icon: "home" | "swap" | "power" | "book" | "list" | "route" | "trophy" }[] = [
  { id: "home", label: "Home", icon: "home" },
  ...(TRADE_TAB_ENABLED ? [{ id: "trade" as const, label: "Floor", icon: "swap" as const }] : []),
  { id: "activate", label: "My Brokers", icon: "power" },
  { id: "feed", label: "Feed", icon: "list" },
  { id: "leaders", label: "Leaders", icon: "trophy" },
  { id: "roadmap", label: "Roadmap", icon: "route" },
  { id: "docs", label: "Docs", icon: "book" },
];

export function Tabs({ active, onChange }: { active: TabId; onChange: (t: TabId) => void }) {
  // Sticky with the page background painted, so content sliding under it never
  // bleeds through; on small screens the row scrolls sideways instead of wrapping
  // into a two-line jumble.
  return (
    <nav
      className="sticky top-0 z-30 bg-cream flex overflow-x-auto border-b-2 border-ink mt-6"
      role="tablist"
    >
      {TABS.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={`font-pixel text-xs px-4 py-3 -mb-0.5 border-b-[3px] flex items-center gap-2 shrink-0 transition-colors duration-150 ${
              on ? "text-ink-strong border-accent" : "text-ink-soft border-transparent hover:text-ink-strong"
            }`}
          >
            <Icon name={t.icon} className="w-[15px] h-[15px]" />
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
