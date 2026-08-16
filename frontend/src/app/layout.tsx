import type { Metadata } from "next";
import { headers } from "next/headers";
import { Silkscreen, Space_Grotesk } from "next/font/google";
import { cookieToInitialState } from "wagmi";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { Providers } from "./providers";
import { wagmiConfig } from "@/lib/wagmi";

const silkscreen = Silkscreen({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-silkscreen",
  display: "swap",
});
const grotesk = Space_Grotesk({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Coattail Brokers",
  description:
    "Own a Broker NFT that mirrors what US Congress buys — earn and claim tokenized stocks into its on-chain wallet.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const initialState = cookieToInitialState(wagmiConfig, (await headers()).get("cookie"));
  return (
    <html lang="en" className={`${silkscreen.variable} ${grotesk.variable}`}>
      <body>
        <Providers initialState={initialState}>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
