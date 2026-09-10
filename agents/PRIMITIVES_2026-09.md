# Primitive bake-off, round 3 (2026-09-08) — evidence and ranking

> Status: RESEARCH, nothing decided. Five parallel surveys (Robinhood Chain ecosystem, NFT
> demand mechanics, Congress-alpha market, tokenized-stock DeFi, standards) plus four
> follow-ups (curator models, launchpad fee plumbing, 278-T data, gacha). Agent Desk
> (`AGENT_DESK.md`) is parked as an idea. Rules applied: outside fuel only (new wallets,
> floor buys, COAT buys), single fungible token, core never modified, no new burn feature,
> every pitch carries the non-dilution Q&A.

## What the chain is doing right now (Sep 1-8)

| Signal | Numbers | Why it matters to us |
|---|---|---|
| Stock-paired memecoins | 432 pools on 19 stocks, 31% of stock-token DEX volume ($95M/day), 17% of the liquid float | The hottest flow on the chain is "memecoin fees paid in stock" |
| Launchpads | Pons $4.5B cum., $25M creator earnings, $5.9M fees/day peak; PAIR (tokens paired vs baskets of ≤5 stocks) $26M in 5 days, 1% fee 70/30; Flap "RWA dividend"; pools.trade (Uniswap Labs) | Creator fee streams are the biggest pool of outside money |
| Gaps named by analysts | no index layer, no dividend layer (ERC-8056 `uiMultiplier`), NFT-fi "essentially absent", no social/leaderboard on-chain, "the yield layer is Morpho alone" | Congress basket + Floor already sit on two of these |
| NFT market | StonkBrokers floor 13 ETH peak → ~5 ETH, 630 owners (14%), floor tracks its token; Spritehood 44,444 sold in 53 min; Gremlin Cartel pays stakers in stock tokens | Breadth of holders is the recovery asset; ours is 1,776 |
| Copy-trading | Autopilot $1.8B AUM, $30M revenue, 6,000 creators waitlisted; Robinhood Social = manual, US-only | The on-chain copy slot is open |
| Gacha | $324M in June, but whale-driven (0.65% of users = 58% of revenue), needs variance + fiat rails; two RH-chain stock-pack clones have 0 and 9 openings | Broker Packs would inherit the legal exposure without the dopamine |
| Timing | Arbitrum Open House Singapore buildathon: submissions Sep 13 - Oct 4, $415K program, ≥1 of 3 prizes per track reserved for Robinhood Chain projects, existing mainnet projects eligible (Saffron, Agama won); Q3 earnings late Oct judges "organic apps" | A shipped primitive by Oct 4 has a prize door |
| Discovery | DefiLlama lists 151 RH-chain protocols incl. StonkBrokers; Coattail is not listed; OpenSea SEA launch lets users stake behind collections | Two free doors, zero build |

## Ranking

### 1. Coattail Sink — "your token pays a Congress dividend" (recommended)

**What.** A periphery contract any launchpad token, memecoin or NFT collection on the chain
can set as its fee recipient. Fees arrive (ETH/USDG/stock tokens), the sink converts them
through The Floor (`buyCustomBasket`, ≤5 legs = top Congress names by weight) and opens a
distribution *round*; the partner's holders claim pro-rata (balance at round open, Merkle
root committed to an archived block, fixed claim window, unclaimed rolls forward: the
PonsVault pattern, keeper-free, no transfer hook needed on tokens we don't control). A
settable slice of every round buys COAT through the hooked pool before the basket buy.

**Why it is fuel.** The three biggest fee pools on the chain can plug in without asking us:
PAIR's `feeRecipients[]` (fees already land in stock tokens, and their "holder distribution"
mode is unshipped), Flap's permissionless `VaultFactory` with a custom `dividendToken`, and
Pons' `transferCreatorFeeRecipient()`. Gremlin Cartel and Chain Mancers already pay holders in
stock tokens and would swap the stock leg for the basket. Every dollar of partner fees becomes
Floor volume (0.3%, 80% to Broker payroll) and carries the scorecard to thousands of wallets
that have never seen a Broker.

**Reuses.** Floor router, Chainlink floors, indexer basket, data-branch publishing, Gift Vault
round/claim UI shape. New: `Sink` (≈300 lines), `RoundDistributor` (Merkle claim), a poster
script, a partner page with a "set this address as your fee recipient" one-liner.

**Non-dilution Q&A.** *NFT?* Payroll grows with every partner's fees; Brokers remain the only
way to receive payroll without claiming; no partner token touches Broker mechanics. *COAT?*
No new fungible; the sink pays in existing stock tokens; a settable COAT slice is bought
through the hooked pool (fees to payroll), no new burn. *Bypass?* A partner cannot get the
scorecard basket without the Floor; the Floor fee is unconditional.

**Legal flags.** Sink briefly pools tokenized debt securities for unnamed claimants (EU/EEA
eligibility of Robinhood stock tokens). Mitigations seen in the wild and to copy: fixed claim
window + rollover (no perpetual custody), claim-time jurisdiction attestation, "community
vault, no redemption right" language is what $AI uses but we should not (holders must claim
something real). Counsel one-pager, same gate as Desk.

**Size.** ~2 weeks incl. mainnet-fork tests against PAIR/Flap contracts and testnet pass.
Fits the buildathon window.

### 2. Curator Desk — Autopilot's "Pilot" model, on-chain, Broker-gated

**What.** Congress-trade creators (Unusual Whales, Quiver, Litquidity, finance YouTubers)
sign one public EIP-712 weighting (≤12 legs, same for everyone, timestamped). A Broker
owner sets their Broker to follow a curator, prepays COAT per 30 days (split 70% curator /
30% protocol sink), and **re-confirms each new weighting with a signature** before the keeper
executes it via the Floor (ESMA Q&A 2012/382 Q9: no automatic execution without client action
= not portfolio management; Lowe v. SEC: a publication for all alike is not advice). Curators
must hold a Broker following their own basket.

**Why it is fuel.** Demand is proven off-chain (Autopilot: $1.8B AUM, $22M of $30M revenue
from Congress-style portfolios, 6,000 creators waiting; Unusual Whales just launched ETFs
with Siebert). Followers need a Broker (floor buys) and pay COAT. This is the Geez campaign
generalised to creators: partner brings the audience, the audience buys Brokers.

**Reuses.** Playbooks allowance pattern, StrategyRegistry EIP-712 shape, Floor, scorecard
(verifiable record per curator), Wallet Pass renderer for shareable cards.

**Non-dilution Q&A.** *NFT?* No Broker, no following; a good curator record makes following
Brokers price above floor. *COAT?* Fees in COAT only, protocol share to the existing sink, no
new token. *Payroll?* Untouched; Floor fees add to it.

**Legal flags.** Adviser-status optics (Autopilot is an RIA). The re-confirmation step and the
publisher framing are the mitigations; lawyer gate before curators are paid.

**Size.** ~3 weeks + BD (creators must say yes; rev-share plus a free Broker, not cash).

### 3. Cabinet lane (executive-branch 278-T) — content, not a primitive

Feasible: OGE's undocumented JSON index (`extapps2.oge.gov/201/Presiden.nsf/API.xsp/v2/rest`)
has 327 278-T PDFs (scanned, vision parse needed; open-cabinet's pipeline is MIT). But the
median disclosure lag is 67 days, the data is mostly Trump's managed model portfolio, and
5 U.S.C. 13107(c) bars commercial use of the reports; the engine trading on them is the
least-protected use. Verdict: a Feed/scorecard lane (news-media posture) if we want the
narrative, never an engine basket. Not fuel.

### 4. Broker Packs (gacha) — rejected

At a $35 floor every pull is the same ~$35 NFT; no variance, so no loop, plus loot-box
exposure (Belgium/NL/UK cash-out test) on an NFT that holds tokenized securities (SEC Reg
Crypto Assets excludes tokenized securities from the "collectible" safe harbour). No VRF on
chain 4663. Two clones launched Aug 18 / Sep 8 with 0 and 9 openings.

### Also rejected this round

Floor-as-UniswapX-filler (thin spread, no COAT path); Broker Drip (sell dividend YT on hdfi:
market tiny); Broker Credit Line (NFT lending down 97% from peak); Congress League prize
draws tied to purchases (sweepstakes optics, prediction-market volumes on political trading
are $17K-$240K); COAT/stock-token pair (already rejected in round 2); Anvil/Clutch
collection token (second fungible).

## Zero-build doors (do regardless)

1. **DefiLlama adapter**: TVL = stock tokens in the 1,776 wallets + Floor; StonkBrokers is
   listed, we are not; every analyst article this month sourced DefiLlama.
2. **Arbitrum Open House Singapore**: register at arbitrum-singapore.hackquest.io; submit the
   shipped primitive by Oct 4; Robinhood Chain projects have a reserved prize per track.
3. **OpenSea**: get the collection and the COAT token page verified before SEA launches
   (users will stake SEA behind collections).
4. **Uniswap Foundation**: router-subsidy form for hooked-pool flow; v4 hook audit subsidies.

## Sources (main)

defiprime stock-paired memecoins; insights4vc "Robinhood Chain two months in"; ChainCatcher
432-pools study; PAIR press release + pair.fund/docs; PonsVault docs; Flap llms-full docs;
Bankr docs; Gremlin Cartel site; BigGo (Autopilot $1.8B/$30M); WallStreetZen Autopilot
review; ESMA Q&A 2012/382; Lowe v. SEC 472 U.S. 181; OGE API live pull; open-cabinet repo;
5 U.S.C. 13107; Blockworks "who is winning the onchain gacha trade"; Chainlink VRF supported
networks; SEC press release 2026-76; Arbitrum Open House Singapore (HackQuest rules);
DefiLlama /protocols API (151 RH-chain protocols, Coattail absent).
