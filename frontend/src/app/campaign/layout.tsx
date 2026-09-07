import type { Metadata } from "next";
import { CAMPAIGN } from "@/lib/campaign";

// Public since the campaign was announced on both sides: indexable, linked from the app's
// navigation, with its own preview card. Before a campaign goes live the page still renders
// its "in preparation" state, so there is nothing to hide.
const title = CAMPAIGN.live && CAMPAIGN.partnerName ? `${CAMPAIGN.partnerName} x Coattail Brokers` : "The sponsored desk";
const description = CAMPAIGN.live && CAMPAIGN.partnerName
  ? `${CAMPAIGN.seats || ""} ${CAMPAIGN.partnerName} holders each get a seat at the desk: a Coattail Broker switched on by burning $COAT, earning real tokenized stock on Robinhood Chain. Every seat, live from the chain.`.trim()
  : "A community's holders, each given a seat at the Coattail desk.";

export const metadata: Metadata = {
  title,
  description,
  openGraph: { title, description, type: "website" },
  twitter: { card: "summary_large_image", title, description },
};

export default function CampaignLayout({ children }: { children: React.ReactNode }) {
  return children;
}
