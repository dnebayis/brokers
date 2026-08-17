"use client";

import type { TabId } from "@/components/Tabs";

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
  { k: "Mint", v: "0.001 ETH" },
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
          <button className="btn btn-accent" onClick={() => onNavigate("mint")}>
            Mint a Broker
          </button>
          <button className="btn btn-ghost" onClick={() => onNavigate("docs")}>
            Read the Docs
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

      {/* How it works */}
      <section className="card">
        <h2 className="pixel-title text-[15px] mb-4">How it works</h2>
        <ol className="grid sm:grid-cols-3 gap-4 text-sm">
          <li>
            <div className="font-pixel text-[12px] text-ink-strong mb-1">1 · Mint &amp; activate</div>
            <p className="text-ink-soft">
              Mint a Broker for 0.001 ETH, then burn some $COAT to switch it on and start earning.
            </p>
          </li>
          <li>
            <div className="font-pixel text-[12px] text-ink-strong mb-1">2 · The flywheel</div>
            <p className="text-ink-soft">
              Every $COAT trade pays a small fee that&rsquo;s turned into dollars and used to buy the
              same stocks Congress is buying.
            </p>
          </li>
          <li>
            <div className="font-pixel text-[12px] text-ink-strong mb-1">3 · Your wallet stacks</div>
            <p className="text-ink-soft">
              Those stocks land in your Broker&rsquo;s wallet. Claim them to your own wallet anytime.
            </p>
          </li>
        </ol>
        <div className="flex flex-wrap gap-3 mt-5">
          <button className="btn btn-accent" onClick={() => onNavigate("mint")}>
            Mint
          </button>
          <button className="btn btn-ghost" onClick={() => onNavigate("feed")}>
            See the live basket
          </button>
        </div>
      </section>
    </div>
  );
}
