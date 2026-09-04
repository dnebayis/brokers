import type { Metadata } from "next";

// Unlisted by intent: reachable by URL, never in search results and never linked from the
// app's own navigation. Robots directives are the only part of "unlisted" a page can enforce.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function CampaignLayout({ children }: { children: React.ReactNode }) {
  return children;
}
