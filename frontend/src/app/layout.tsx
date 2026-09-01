import type { Metadata } from "next";
import { headers } from "next/headers";
import { Silkscreen, Space_Grotesk } from "next/font/google";
import { cookieToInitialState } from "wagmi";
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

const DESCRIPTION =
  "Own a Broker NFT that mirrors what US Congress buys — earn and claim tokenized stocks into its on-chain wallet.";

export const metadata: Metadata = {
  metadataBase: new URL("https://coattail.cash"),
  title: "Coattail Brokers",
  description: DESCRIPTION,
  openGraph: {
    title: "Coattail Brokers",
    description: DESCRIPTION,
    url: "/",
    siteName: "Coattail Brokers",
    images: [{ url: "/brand/x-cover.png", width: 1500, height: 500 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Coattail Brokers",
    description: DESCRIPTION,
    images: ["/brand/x-cover.png"],
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const initialState = cookieToInitialState(wagmiConfig, (await headers()).get("cookie"));
  return (
    <html lang="en" className={`${silkscreen.variable} ${grotesk.variable}`}>
      <body>
        <Providers initialState={initialState}>{children}</Providers>
      </body>
    </html>
  );
}
