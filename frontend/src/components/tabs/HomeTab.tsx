"use client";

import type { TabId } from "@/components/Tabs";
import { HomeMetrics } from "@/components/HomeMetrics";
import { ActivationMath } from "@/components/ActivationMath";
import { ProofPanel } from "@/components/ProofPanel";
import { GiftsPanel } from "@/components/GiftsPanel";
import { OPENSEA_URL } from "@/lib/config";

// Featured rare Brokers (fully on-chain 1-bit art; served from /public/gallery).
const RARES: { src: string; id: string; kind: string }[] = [
  { src: "/gallery/alien-405.png", id: "#405", kind: "Alien" },
  { src: "/gallery/ape-178.png", id: "#178", kind: "Ape" },
  { src: "/gallery/rare-1648.png", id: "#1648", kind: "Zombie" },
  { src: "/gallery/rare-1176.png", id: "#1176", kind: "Rare" },
  { src: "/gallery/rare-311.png", id: "#311", kind: "Rare" },
  { src: "/gallery/rare-1684.png", id: "#1684", kind: "Rare" },
];

const FACTS: { k: string; v: string }[] = [
  { k: "Collection", v: "1,776" },
  { k: "Mint", v: "sold out" },
  { k: "Token", v: "$COAT · fair launch" },
  { k: "Team allocation", v: "0%" },
];

export function HomeTab({ onNavigate }: { onNavigate: (t: TabId) => void }) {
  return (
    <div className="grid gap-6">
      {/* Hero */}
      <section className="card">
        <p className="chip mb-4 inline-block">Ride the coattails of smart money</p>
        <h1 className="pixel-title text-[22px] sm:text-[28px] leading-snug mb-3">
          Whatever Congress buys,
          <br />
          your Broker buys too.
        </h1>
        <p className="text-ink-soft text-sm sm:text-base max-w-xl mb-5">
          1,776 NFTs that follow US Congress&rsquo; disclosed stock trades and invest for you,
          automatically. Each Broker is a little wallet that quietly stacks real tokenized stocks —
          no charts to watch, no buttons to press.
        </p>
        <div className="flex flex-wrap gap-3">
          <a className="btn btn-accent" href={OPENSEA_URL} target="_blank" rel="noopener noreferrer">
            Get a Broker &#8599;
          </a>
          <button className="btn btn-ghost" onClick={() => onNavigate("docs")}>
            Read the Docs
          </button>
        </div>
      </section>

      {/* Start here — the first thing a new visitor needs: what to actually do */}
      <section className="card">
        <h2 className="pixel-title text-[15px] mb-4">New here? Three steps.</h2>
        <ol className="grid sm:grid-cols-3 gap-5">
          <li className="flex flex-col">
            <div className="font-pixel text-[12px] text-accent mb-1.5">STEP 1</div>
            <div className="font-pixel text-[13px] text-ink-strong mb-1.5">Get a Broker</div>
            <p className="text-ink-soft text-sm mb-3">
              The mint sold out — Brokers trade on the secondary market. Each one is an NFT with its
              own real on-chain wallet.
            </p>
            <a className="btn btn-accent mt-auto self-start text-[11px] px-3 py-2.5" href={OPENSEA_URL}
              target="_blank" rel="noopener noreferrer">
              Browse OpenSea &#8599;
            </a>
          </li>
          <li className="flex flex-col">
            <div className="font-pixel text-[12px] text-accent mb-1.5">STEP 2</div>
            <div className="font-pixel text-[13px] text-ink-strong mb-1.5">Switch it on</div>
            <p className="text-ink-soft text-sm mb-3">
              Burn 36,750 $COAT to activate it. From that moment your Broker earns a share of every
              stock purchase the engine makes.
            </p>
            <button className="btn btn-ghost mt-auto self-start text-[11px] px-3 py-2.5"
              onClick={() => onNavigate("activate")}>
              Open My Brokers &#8594;
            </button>
          </li>
          <li className="flex flex-col">
            <div className="font-pixel text-[12px] text-accent mb-1.5">STEP 3</div>
            <div className="font-pixel text-[13px] text-ink-strong mb-1.5">That&rsquo;s it — it earns</div>
            <p className="text-ink-soft text-sm mb-3">
              It buys what Congress discloses, automatically. Real tokenized stock lands in its
              wallet — claim or withdraw it whenever you like.
            </p>
            <button className="btn btn-ghost mt-auto self-start text-[11px] px-3 py-2.5"
              onClick={() => onNavigate("feed")}>
              See what it buys &#8594;
            </button>
          </li>
        </ol>
      </section>

      {/* The Floor — the no-NFT path in, one line, straight to the terminal */}
      <section className="card border-l-[3px] border-l-accent">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="pixel-title text-[15px] mb-1">Just want the basket?</h2>
            <p className="text-ink-soft text-sm">
              Skip the NFT: <b className="text-ink-strong">The Floor</b> trades the live Congress
              basket in one transaction — pay with $COAT, ETH or USDG, exit any time. Every trade
              helps fund Broker salaries.
            </p>
          </div>
          <button className="btn btn-accent shrink-0" onClick={() => onNavigate("trade")}>
            Open the Floor &#8594;
          </button>
        </div>
      </section>

      {/* Facts */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {FACTS.map((f) => (
          <div key={f.k} className="stat">
            <div className="text-[11px] text-ink-soft uppercase tracking-widest">{f.k}</div>
            <div className="font-pixel text-base text-ink-strong mt-1">{f.v}</div>
          </div>
        ))}
      </section>

      {/* Live on-chain metrics */}
      <HomeMetrics />

      {/* Shell vs working Broker — the live activation math */}
      <ActivationMath onNavigate={onNavigate} />

      {/* Gift drops — hidden until the vault address is configured */}
      <GiftsPanel />

      {/* Rare gallery */}
      <section className="card">
        <h2 className="pixel-title text-[15px] mb-1">A few of the rares</h2>
        <p className="text-ink-soft text-sm mb-5">
          Fully on-chain 1-bit portraits. Alien, Ape and Zombie are the scarce types; every Broker
          also carries live status and its accrued holdings in its metadata.
        </p>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5">
          {RARES.map((r) => (
            <figure key={r.src} className="border-2 border-ink bg-cream p-1">
              <img
                src={r.src}
                alt={`Coattail Broker ${r.id} (${r.kind})`}
                width={200}
                height={200}
                className="block w-full h-auto"
                style={{ imageRendering: "pixelated" }}
              />
              <figcaption className="font-pixel text-[9px] text-ink-strong text-center mt-1">
                {r.kind} {r.id}
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      {/* Proof & transparency — verifiable facts + live burn/buy activity.
          Deliberately last: it is the densest section, for auditors, not newcomers. */}
      <ProofPanel />
    </div>
  );
}
