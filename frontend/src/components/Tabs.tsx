"use client";

import { useRef, type KeyboardEvent } from "react";
import { Icon } from "./ui/Icon";
import { TRADE_TAB_ENABLED } from "@/lib/floor";

export type TabId = "home" | "trade" | "activate" | "feed" | "leaders" | "stats" | "roadmap" | "docs";

// Labels say what the page IS for the visitor, not what the protocol calls the
// action: "Activate" hid the fact that the tab is your whole portfolio.
const TABS: { id: TabId; label: string; icon: "home" | "swap" | "power" | "book" | "list" | "route" | "trophy" | "chart" }[] = [
  { id: "home", label: "Home", icon: "home" },
  ...(TRADE_TAB_ENABLED ? [{ id: "trade" as const, label: "Floor", icon: "swap" as const }] : []),
  { id: "activate", label: "My Brokers", icon: "power" },
  { id: "feed", label: "Feed", icon: "list" },
  { id: "leaders", label: "Leaders", icon: "trophy" },
  { id: "stats", label: "Stats", icon: "chart" },
  { id: "roadmap", label: "Roadmap", icon: "route" },
  { id: "docs", label: "Docs", icon: "book" },
];

/** ids shared with the panel that each tab controls (page.tsx sets them on the panel). */
export const tabButtonId = (t: TabId) => `tab-${t}`;
export const tabPanelId = (t: TabId) => `tabpanel-${t}`;

export function Tabs({ active, onChange }: { active: TabId; onChange: (t: TabId) => void }) {
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  // WAI-ARIA tabs: only the selected tab sits in the tab order; Left/Right (wrapping),
  // Home and End move between tabs and select as they go (automatic activation).
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const target = TABS[next];
    onChange(target.id);
    buttons.current[target.id]?.focus();
  }
  // Sticky with the page background painted, so content sliding under it never
  // bleeds through; on small screens the row scrolls sideways instead of wrapping
  // into a two-line jumble.
  return (
    <nav
      className="sticky top-0 z-30 bg-cream flex overflow-x-auto border-b-2 border-ink mt-6"
      role="tablist"
      aria-label="Sections"
    >
      {TABS.map((t, i) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            id={tabButtonId(t.id)}
            ref={(el) => { buttons.current[t.id] = el; }}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={tabPanelId(t.id)}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
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
