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
import { RoadmapTab } from "@/components/tabs/RoadmapTab";
import { DocsTab } from "@/components/tabs/DocsTab";

export default function Page() {
  const [tab, setTab] = useState<TabId>("home");
  useEffect(() => {
    const saved = window.location.hash.slice(1) || window.localStorage.getItem("coattail.activeTab") || "";
    const allowed = ["home", "activate", "feed", "roadmap", "docs", ...(SWAP_ENABLED ? ["swap"] : [])];
    if (allowed.includes(saved)) setTab(saved as TabId);
  }, []);

  function selectTab(next: TabId) {
    setTab(next);
    window.localStorage.setItem("coattail.activeTab", next);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${next}`);
  }
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex-1">
        <Tabs active={tab} onChange={selectTab} />
        {tab === "home" ? (
          <div className="py-6 lg:py-8">
            <HomeTab onNavigate={selectTab} />
          </div>
        ) : (
          <div className="py-6 lg:py-8 grid gap-6 lg:gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
            <div className="min-w-0">
              {tab === "swap" && SWAP_ENABLED && <SwapTab />}
              {tab === "activate" && <ActivateTab />}
              {tab === "feed" && <FeedTab />}
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
