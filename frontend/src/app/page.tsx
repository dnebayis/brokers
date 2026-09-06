"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { Tabs, tabButtonId, tabPanelId, type TabId } from "@/components/Tabs";
import { TRADE_TAB_ENABLED } from "@/lib/floor";
import { SidePanel } from "@/components/SidePanel";
import { HomeTab } from "@/components/tabs/HomeTab";
import { TradeTab } from "@/components/tabs/TradeTab";
import { ActivateTab } from "@/components/tabs/ActivateTab";
import { FeedTab } from "@/components/tabs/FeedTab";
import { LeadersTab } from "@/components/tabs/LeadersTab";
import { StatsTab } from "@/components/tabs/StatsTab";
import { RoadmapTab } from "@/components/tabs/RoadmapTab";
import { DocsTab } from "@/components/tabs/DocsTab";
import { CoatAddress, SocialLinks } from "@/components/ui/SocialLinks";

export default function Page() {
  const [tab, setTab] = useState<TabId>("home");
  useEffect(() => {
    const saved = window.location.hash.slice(1) || window.localStorage.getItem("coattail.activeTab") || "";
    const allowed = ["home", "activate", "feed", "leaders", "stats", "roadmap", "docs", ...(TRADE_TAB_ENABLED ? ["trade"] : [])];
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
          <div key={tab} id={tabPanelId(tab)} role="tabpanel" aria-labelledby={tabButtonId(tab)} className="tab-panel py-6 lg:py-8">
            <HomeTab onNavigate={selectTab} />
          </div>
        ) : (
          <div
            key={tab}
            id={tabPanelId(tab)}
            role="tabpanel"
            aria-labelledby={tabButtonId(tab)}
            className="tab-panel py-6 lg:py-8 grid gap-6 lg:gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start"
          >
            <div className="min-w-0">
              {tab === "trade" && TRADE_TAB_ENABLED && <TradeTab />}
              {tab === "activate" && <ActivateTab />}
              {tab === "feed" && <FeedTab />}
              {tab === "leaders" && <LeadersTab />}
              {tab === "stats" && <StatsTab />}
              {tab === "roadmap" && <RoadmapTab />}
              {tab === "docs" && <DocsTab />}
            </div>
            <SidePanel />
          </div>
        )}
      </main>
      <footer className="border-t-2 border-ink">
        <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SocialLinks variant="labels" />
            <CoatAddress />
          </div>
          <div className="text-xs text-ink-soft flex flex-wrap justify-between gap-2">
            <span>Coattail Brokers · fully on-chain on Robinhood Chain</span>
            <span>Not financial or legal advice · participation involves risk</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
