"use client";

import { useEffect, useState } from "react";
import { RoutingNotice } from "@/components/trade/RoutingNotice";
import { ADDR, CONTRACTS_FOR_DOCS } from "@/lib/config";
import { activeChain } from "@/lib/chains";
import { publicClient as client } from "@/lib/client";
import { coatAbi } from "@/lib/abis";
import { Icon } from "@/components/ui/Icon";

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="font-pixel text-base text-ink-strong mt-9 mb-2.5 pb-1.5 border-b border-line">{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="text-ink leading-relaxed my-2.5">{children}</p>;
}
function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-pixel text-[12px] bg-cream-3 px-1.5 py-0.5">{children}</code>;
}

export function DocsTab() {
  const [copied, setCopied] = useState("");
  const copy = (a: string) => {
    navigator.clipboard?.writeText(a);
    setCopied(a);
    setTimeout(() => setCopied(""), 1200);
  };

  return (
    <div className="max-w-3xl">
      <p className="text-lg text-ink-strong leading-relaxed">
        Fee-funded stock purchases follow the latest valid disclosed-Congress basket on-chain.
      </p>
      <P>
        A <b>Broker</b> is an NFT with its own smart-contract wallet. While active it accrues a token-ID-specific
        claim on real tokenized equities derived from publicly disclosed US Congress trades. The owner claims
        whole raw-token amounts into the Broker wallet. Assets left there move with the NFT; the owner can also
        withdraw them before selling. Rewards are trading-volume funded and never guaranteed.
      </P>
      <div className="flex flex-wrap gap-2 my-3">
        {["1,776 Brokers", "ERC-6551 wallets", "Real tokenized stocks", "Uniswap v4", "The Floor terminal", "Permanent LP lock"].map((p) => (
          <span key={p} className="border border-line bg-cream-2 px-2.5 py-1 text-xs">{p}</span>
        ))}
      </div>

      <H>The lore</H>
      <P>
        Politicians are unusually good at trading. Their trades are public record (the STOCK Act), endlessly
        memeable, and dominated by exactly the mega-cap tech names Robinhood Chain has tokenized. Coattail
        Brokers turns that into an ownable primitive: 1,776 operatives — the number of American independence —
        each a distinct 1-bit PFP portrait. The exact type distribution is <b>2 Alien</b>, <b>4 Ape</b>,{" "}
        <b>16 Zombie</b>, <b>681 Female</b>, and <b>1,073 Male</b>. Headwear, eyes, mouth, jewelry and face
        traits use fixed published counts and may overlap. Every token has at least one non-None optional metadata
        trait. All 1,776 canonical bitmap/trait pairs have passed the documented collection audit; on-chain upload
        and network-specific renderer wiring are verified independently during each release deployment.
      </P>

      <H>How it works</H>
      <ol className="list-decimal ml-5 space-y-1.5 text-ink my-2.5">
        <li><b>Acquire</b> a Broker. Primary mint is closed — all 1,776 were minted at 0.001 ETH, each drawing a unique non-sequential ID and creating its own ERC-6551 wallet; Brokers now change hands on the secondary market.</li>
        <li><b>Activate</b> it — burn 36,750 $COAT (<Code>activate()</Code>). The Broker switches ON and joins the earning set. Burning is a pure sink: nothing is handed back, so there&apos;s no mint-and-dump.</li>
        <li><b>Earn</b> — a staged permissionless keeper flushes fees and, above threshold, buys the latest valid Congress basket. Purchases become <Code>claimable(tokenId)</Code>; the owner claims them into the Broker wallet.</li>
        <li><b>Transfer</b> — selling an active Broker turns it OFF. Unclaimed entitlement and assets left in its wallet follow the NFT; the buyer re-burns $COAT to resume.</li>
      </ol>

      <H>Random IDs and fairness</H>
      <P>
        Token IDs are selected without replacement from <Code>1..1776</Code> with a sparse
        Fisher–Yates pool. A two-NFT mint therefore returns two different IDs, and a complete
        sellout is an exact permutation of the collection. Entropy combines the previous block,
        <Code>prevrandao</Code>, minter, chain, contract and mint counters, resolved in the same
        transaction so no ID is visible before it&apos;s assigned. It uses on-chain block entropy
        rather than an external VRF; timestamp alone is never used.
      </P>

      <H>Owning multiple Brokers</H>
      <P>
        Rewards are counted per active NFT, not per wallet. One active Broker earns one equal share;
        two active Brokers earn two shares and require a total activation burn of <b>73,500 COAT</b>.
        Each Broker keeps separate activation state, pending rewards and its own TBA balances. Moving
        one NFT turns off only that NFT. Its pending entitlement and assets left in its TBA follow the
        NFT, while the owner&apos;s other Brokers continue earning normally. The two-NFT limit applies only
        to primary minting; secondary transfers may result in a wallet owning more than two.
      </P>

      <H>The flywheel</H>
      <P>
        The engine is <b>$COAT trading volume</b>, not NFT royalties. The <Code>CoatFeeHook</Code> — a live
        Uniswap v4 <Code>afterSwap</Code> hook — skims 1% of every swap: <b>sells</b> (COAT→ETH) take the fee
        in ETH → <Code>FeeSplitter</Code> → the flywheel; <b>buys</b> (ETH→COAT) take it in COAT and burn it, reducing <Code>totalSupply</Code>. The
        FeeSplitter&rsquo;s ratios are fixed at <b>80 / 10 / 10</b>, but each slice&rsquo;s destination is a
        settable sink. Both the buyback slice (by holder vote) and the project treasury slice (by owner
        decision) now point at the Booster, so <b>100% of every $COAT trade fee buys stock for holders</b>.
        Reversible by the same setter; the change is visible on the FeeSplitter contract.
      </P>
      <P>
        Contracts do not run themselves. An independent hourly keeper advances hook flush, splitter flush,
        threshold-eligible stock purchase and TWAP-eligible buyback stages. If it is offline, balances roll
        forward and anyone may call the permissionless entry points.
      </P>

      <H>The Floor</H>
      <P>
        The <b>Floor</b> tab is the public trading terminal on the same rails the engine uses: one
        transaction buys the entire live Congress basket at its live weights, paying with $COAT, ETH
        or USDG — and exits work the same way, whole position or a slice, into any of the three.
        Every leg is priced against Chainlink with a hard on-chain minimum, so no pool can quote a
        fill below the floor. It is non-custodial: everything settles into your wallet within the
        same transaction, and the contract only ever holds accrued fees. The fee is 0.3%
        (owner-lowerable, hard-capped at 1%); a keeper converts it to native ETH and streams{" "}
        <b>100% into the Booster payroll</b> (the treasury share was set to zero). Paying with — or exiting into —
        $COAT routes through the hooked pool, so those trades feed the flywheel twice.
      </P>

      <H>Tokenomics</H>
      <table className="w-full border-collapse text-sm my-2">
        <tbody>
          {[
            ["$COAT supply", "1,000,000,000 (fixed, burnable)"],
            ["Launch liquidity", "100% (1B) single-sided v4, zero ETH from us; LP permanent"],
            ["Strategic reserve", "None — no team/reserve allocation"],
            ["Activation burn", "36,750 $COAT / Broker (immutable)"],
            ["Primary mint cap", "2 per address; secondary ownership unrestricted"],
            ["Mint price", "0.001 ETH → creator"],
            ["Secondary royalty", "2.5% → current creator (ERC-2981)"],
            ["Fee split", "80/10/10 constants; buyback and treasury sinks both point at the Booster — effective 100% stock"],
          ].map(([k, v]) => (
            <tr key={k}>
              <td className="border border-line px-2.5 py-2 font-medium w-40">{k}</td>
              <td className="border border-line px-2.5 py-2">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <TokenomicsCharts />

      <H>The oracle (the honest part)</H>
      <P>
        Congressional trades are off-chain. An indexer ingests STOCK Act disclosures, maps each holding to a
        Robinhood Chain stock token, drops untokenized names, renormalizes to 100%, and posts the target
        weights <b>signed EIP-712</b> to the <Code>StrategyRegistry</Code> (monotonic epoch, per-epoch drift
        cap, anyone can relay). It&apos;s a disclosed trusted signer in v1 — sources and mapping are published
        so any posted vector is checkable against public filings. Disclosures lag up to ~45 days (median ~26):
        Brokers track what was <i>filed</i>, framed openly as a feature.
      </P>
      <P>
        <b>How much gets dropped is the part worth stating plainly.</b> Congress buys whatever it likes;
        this chain has tokenized a fraction of it, and of that fraction only names with a live pool
        <i>and</i> an official price feed can be bought safely. In recent windows that has meant the
        basket represents a <b>minority</b> of all disclosed net buying, sometimes under a fifth, and a
        single untradable name can dominate what is left out. So a Broker mirrors Congress <i>within the
        set this chain can actually trade</i>, not the whole disclosed portfolio. The engine expands that
        set whenever a name clears the bar — it is 25 names today — and every run publishes both the
        coverage figure and the biggest names it had to skip, so the gap is measurable rather than
        implied.
      </P>

      <H>Contracts — live on {activeChain.name}</H>
      <table className="w-full border-collapse text-[13px] my-2">
        <thead>
          <tr>
            <th className="border border-line bg-cream-3 px-2.5 py-2 text-left font-pixel text-[10px] uppercase">Contract</th>
            <th className="border border-line bg-cream-3 px-2.5 py-2 text-left font-pixel text-[10px] uppercase">Address</th>
          </tr>
        </thead>
        <tbody>
          {CONTRACTS_FOR_DOCS.filter(({ key }) => !!ADDR[key]).map(({ name, key }) => {
            const a = ADDR[key] as string;
            return (
              <tr key={name}>
                <td className="border border-line px-2.5 py-2">{name}</td>
                <td className="border border-line px-2.5 py-2 font-pixel text-[11px] break-all">
                  {a}{" "}
                  <button onClick={() => copy(a)} className="text-ink-soft hover:text-accent align-middle" aria-label="copy address">
                    <Icon name={copied === a ? "check" : "copy"} className="w-3.5 h-3.5 inline" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-ink-soft text-sm mt-1">
        v4 pool id: <Code>{ADDR.poolId.slice(0, 10)}…{ADDR.poolId.slice(-6)}</Code> · fee 1% · single-sided 1B $COAT.
      </p>
      <div className="mt-3">
        <RoutingNotice compact />
      </div>

      <H>Open Broker API</H>
      <P>
        A free, keyless read API for integrators — campaign tooling, dashboards, partner collections.
        Everything it returns is derived live from the verified contracts; the API just saves you the ABI
        work. Responses are CDN-cached for up to an hour, so treat the chain as the source of truth for
        anything real-time. No authentication, no rate keys, JSON only.
      </P>
      <div className="space-y-4 my-3">
        <div className="border border-line bg-cream-2 p-3">
          <div className="font-pixel text-[12px] text-ink-strong">GET /api/broker/{"{id}"}</div>
          <p className="text-sm text-ink mt-1.5">
            One Broker&apos;s full state: current <Code>owner</Code>, its ERC-6551 <Code>wallet</Code>,{" "}
            <Code>active</Code> flag, <Code>claimable</Code> salary still sitting in the Booster, and{" "}
            <Code>holdings</Code> already claimed into the wallet. Amounts come as raw units
            (string) plus a <Code>formatted</Code> decimal. <Code>404</Code> if the token doesn&apos;t exist.
          </p>
        </div>
        <div className="border border-line bg-cream-2 p-3">
          <div className="font-pixel text-[12px] text-ink-strong">GET /api/wallet/{"{address}"}/brokers</div>
          <p className="text-sm text-ink mt-1.5">
            Every Broker a wallet currently holds: <Code>id</Code>, <Code>active</Code> status and each
            Broker&apos;s 6551 <Code>wallet</Code>, plus a <Code>count</Code>. Ownership is confirmed
            on-chain per token, so a stale marketplace index can&apos;t leak into results.
          </p>
        </div>
      </div>
      <p className="text-ink-soft text-sm">
        Example: <Code>curl https://www.coattail.cash/api/broker/311</Code> — both endpoints also return the
        chain id and core contract addresses so integrations never hardcode them.
      </p>

      <H>Security &amp; trust</H>
      <ul className="list-disc ml-5 space-y-1.5 text-ink my-2.5">
        <li><b>Your funds, your keys.</b> Before claim, entitlement is recorded in Booster; after claim, stock is in the Broker&apos;s ERC-6551 wallet controlled by the current NFT holder.</li>
        <li><b>Non-custodial.</b> This dapp only prepares transactions your wallet signs. It never sees a private key.</li>
        <li><b>Explicit amounts.</b> Every mint/activate/swap shows the exact value, and swaps show a minimum-received floor before you sign.</li>
        <li><b>Network guard.</b> Actions refuse to send unless you&apos;re on {activeChain.name} ({activeChain.id}).</li>
        <li><b>Permissionless progress.</b> Fee flush, stock purchase and buyback entry points can be called by third parties; our keeper is convenience, not automatic contract execution.</li>
        <li><b>Open source &amp; verified.</b> Every contract&apos;s source is published and verified on the explorer for anyone to read. No third-party audit firm was engaged — review the code yourself before you transact.</li>
      </ul>

      <H>Risk &amp; legal</H>
      <P>
        Rewards are <b>volume-funded, not guaranteed yield</b> — if trading dies, the Booster has nothing to
        spend. Access to third-party assets and venues can depend on their terms and applicable law. We use the descriptive name &quot;The Politician,&quot; never a person&apos;s name or likeness,
        and imply no affiliation with Robinhood. Not financial or legal advice.
      </P>
    </div>
  );
}

function TokenomicsCharts() {
  // Live burn line: total supply only ever shrinks (activations + fee burns + buybacks),
  // so read it once per mount. A static figure here went stale within days of launch.
  const [supply, setSupply] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    client.readContract({ address: ADDR.coat, abi: coatAbi, functionName: "totalSupply" })
      .then((v) => { if (live) setSupply(Number(v / 10n ** 18n)); })
      .catch(() => { /* chart falls back to the label-only state */ });
    return () => { live = false; };
  }, []);
  const INITIAL = 1_000_000_000;
  const burned = supply !== null ? INITIAL - supply : null;
  const fmtInt = (n: number) => n.toLocaleString("en-US");
  return (
    <div className="grid sm:grid-cols-2 gap-3 my-5" aria-label="Tokenomics charts">
      <Chart title="Initial COAT allocation" rows={[["Permanent LP", 100, "1B"], ["Team / reserve", 0, "0"]]} />
      <Chart title="Sell-side fee flow (post-vote)" rows={[["Stock rewards", 100, "100%"], ["Treasury", 0, "0%"]]} />
      <div className="border border-line bg-cream-2 p-3 sm:col-span-2">
        <div className="font-pixel text-[11px] mb-3">Supply so far — burns only ever remove</div>
        <svg viewBox="0 0 600 150" className="w-full" role="img"
          aria-label={supply !== null ? `COAT supply has fallen from one billion to ${fmtInt(supply)}` : "COAT supply chart"}>
          <path d="M30 25 L570 125" fill="none" stroke="var(--c-ink)" strokeWidth="5" />
          <circle cx="30" cy="25" r="7" fill="var(--c-ink-strong)" />
          <circle cx="570" cy="125" r="7" fill="var(--c-accent)" />
          <text x="30" y="17" fontSize="15" fill="var(--c-ink-strong)">1,000,000,000</text>
          <text x="430" y="147" fontSize="15" fill="var(--c-ink-strong)">{supply !== null ? fmtInt(supply) : "live from chain…"}</text>
          <text x="230" y="78" fontSize="13" fill="var(--c-accent)">{burned !== null ? `${fmtInt(burned)} COAT burned — live` : ""}</text>
        </svg>
      </div>
      <Chart title="Launch price / FDV band" rows={[["Start FDV", 1, "10 ETH"], ["Graduation", 42, "4.2 ETH principal"], ["Band end FDV", 100, "1,000 ETH"]]} />
      <Chart title="Automation cadence" rows={[["Keeper checks", 100, "hourly"], ["Basket refresh", 17, "every 6h"]]} />
    </div>
  );
}

function Chart({ title, rows }: { title: string; rows: [string, number, string][] }) {
  return (
    <div className="border border-line bg-cream-2 p-3">
      <div className="font-pixel text-[11px] mb-3">{title}</div>
      <div className="space-y-2">
        {rows.map(([label, width, value]) => (
          <div key={label}>
            <div className="flex justify-between text-xs mb-1"><span>{label}</span><b>{value}</b></div>
            <div className="h-3 border border-ink bg-cream"><div className="h-full bg-ink" style={{ width: `${Math.max(width, 1)}%` }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
