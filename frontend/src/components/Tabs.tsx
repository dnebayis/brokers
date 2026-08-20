"use client";

import { Icon } from "./ui/Icon";
import { SWAP_ENABLED } from "@/lib/config";

export type TabId = "home" | "swap" | "activate" | "feed" | "docs";

const TABS: { id: TabId; label: string; icon: "home" | "swap" | "power" | "book" | "list" }[] = [
  { id: "home", label: "Home", icon: "home" },
  ...(SWAP_ENABLED ? [{ id: "swap" as const, label: "Swap", icon: "swap" as const }] : []),
  { id: "activate", label: "Activate", icon: "power" },
  { id: "feed", label: "Feed", icon: "list" },
  { id: "docs", label: "Docs", icon: "book" },
];

export function Tabs({ active, onChange }: { active: TabId; onChange: (t: TabId) => void }) {
  return (
    <nav className="flex flex-wrap border-b-2 border-ink mt-6" role="tablist">
      {TABS.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={`font-pixel text-xs px-4 py-3 -mb-0.5 border-b-[3px] flex items-center gap-2 ${
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
