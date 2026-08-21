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

export const metadata: Metadata = {
  title: "Coattail Brokers",
  description:
    "Own a Broker NFT that mirrors what US Congress buys — earn and claim tokenized stocks into its on-chain wallet.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const initialState = cookieToInitialState(wagmiConfig, (await headers()).get("cookie"));
  return (
    <html lang="en" className={`${silkscreen.variable} ${grotesk.variable}`} suppressHydrationWarning>
      <body>
        {/* Applies the saved (or OS-preferred) theme before first paint, so a dark-mode
            visitor never sees a cream flash. Runs synchronously by design. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var t=localStorage.getItem("coattail.theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}})()',
          }}
        />
        <Providers initialState={initialState}>{children}</Providers>
      </body>
    </html>
  );
}
