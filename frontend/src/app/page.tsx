"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { Tabs, type TabId } from "@/components/Tabs";
import { SWAP_ENABLED } from "@/lib/config";
import { SidePanel } from "@/components/SidePanel";
import { HomeTab } from "@/components/tabs/HomeTab";
import { SwapTab } from "@/components/tabs/SwapTab";
import { ActivateTab } from "@/components/tabs/ActivateTab";
import { FeedTab } from "@/components/tabs/FeedTab";
import { LeadersTab } from "@/components/tabs/LeadersTab";
import { RoadmapTab } from "@/components/tabs/RoadmapTab";
import { DocsTab } from "@/components/tabs/DocsTab";

export default function Page() {
  const [tab, setTab] = useState<TabId>("home");
  useEffect(() => {
    const saved = window.location.hash.slice(1) || window.localStorage.getItem("coattail.activeTab") || "";
    const allowed = ["home", "activate", "feed", "leaders", "roadmap", "docs", ...(SWAP_ENABLED ? ["swap"] : [])];
    if (allowed.includes(saved)) setTab(saved as TabId);
  }, []);

  function selectTab(next: TabId) {
    setTab(next);
    window.localStorage.setItem("coattail.activeTab", next);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${next}`);
    // A tab is a page: start it at the top instead of wherever the last one was
    // scrolled. Instant, not smooth — the panel's own fade covers the change.
    window.scrollTo({ top: 0 });
  }
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex-1">
        <Tabs active={tab} onChange={selectTab} />
        {/* key remounts the panel per tab so the entrance animation replays */}
        {tab === "home" ? (
          <div key={tab} className="tab-panel py-6 lg:py-8">
            <HomeTab onNavigate={selectTab} />
          </div>
        ) : (
          <div key={tab} className="tab-panel py-6 lg:py-8 grid gap-6 lg:gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
            <div className="min-w-0">
              {tab === "swap" && SWAP_ENABLED && <SwapTab />}
              {tab === "activate" && <ActivateTab />}
              {tab === "feed" && <FeedTab />}
              {tab === "leaders" && <LeadersTab />}
              {tab === "roadmap" && <RoadmapTab />}
              {tab === "docs" && <DocsTab />}
            </div>
            <SidePanel />
          </div>
        )}
      </main>
      <footer className="border-t-2 border-ink">
        <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 text-xs text-ink-soft flex flex-wrap justify-between gap-2">
          <span>Coattail Brokers · fully on-chain on Robinhood Chain</span>
          <span>Not financial or legal advice · participation involves risk</span>
        </div>
      </footer>
    </div>
  );
}
