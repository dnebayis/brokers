# Coattail Brokers — Whitepaper v1

> **Coattail Brokers** — ride the coattails of smart money. Own an active Broker NFT that accrues a claim on the tokenized-stock basket derived from disclosed US Congress trades, funded by the collection's own trading.
>
> Status: **mainnet not deployed.** A fresh chain-46630 staging deployment is live with its mint open and full renderer submission complete. Its StrategyRegistry is at epoch 1 with a deterministic test basket, and Brokers #487 and #742 have received the basket assets into their TBAs via receipt-checked claims. The full 888-wallet load, a clean market-hours mainnet-fork report, the renderer read-back sweep and production key/provider configuration remain mainnet-release gates. See `STATUS.md`. Not financial or legal advice.

---

## 1. One-liner

**Whatever Congress buys, your Broker buys too — automatically, on-chain, in real tokenized stocks.**

A **Broker** is an NFT with its own smart-contract wallet. Purchases first create a token-ID-specific `claimable` entitlement in the Booster; the current NFT owner can claim whole raw-token amounts into that ERC-6551 wallet. Claimed stocks travel with the NFT only while they remain in its wallet—the owner can withdraw them before a sale.

---

## 2. Why (the wedge)

StonkBrokers proves the primitive **NFT + ERC-6551 wallet + fee-funded tokenized-stock rewards** on Robinhood Chain. Its current Directed Clock In v2 lets each activated broker elect up to three reward tokens and choose weights; it is not accurately described as a random-stock system.

Stackers provides a second useful benchmark: users also choose up to three assets, hourly rounds roll sub-minimum amounts forward, and keeper failure delays rather than confiscates funds. Its public postmortem of a retired engine whose router mismatch made purchases revert reinforces our requirement to probe every production route before launch.

Coattail Brokers replaces randomness and static baskets with **a story everyone already understands**: *politicians are unusually good at trading, and now you can copy them.* Congressional trades are public (STOCK Act), endlessly memeable, and — crucially — dominated by exactly the mega-cap tech names that Robinhood Chain has tokenized. The product answers "why this NFT?" in one sentence.

We **keep** the fee→stock flywheel and the burn-to-activate gate, and differentiate on three axes:
1. **A living, dynamic basket** — Congress's disclosed trades, refreshed each epoch — not a fixed index.
2. **Real per-NFT self-custody** — after owner-initiated claim, rewards land inside the Broker's ERC-6551 wallet. The wallet is controlled by the current NFT owner, who may leave assets with the NFT or withdraw them.
3. **Fully on-chain 1-bit art** + `strategy` trait for future strategies in one collection.

---

## 3. Building blocks (verified)

The system composes with existing stock tokens and never invokes their mint path. This is a
technical architecture statement, not a conclusion about licensing or other obligations.

| Block | Role | Constraint |
|---|---|---|
| **Robinhood Chain** | Arbitrum Orbit L2, permissionless deploy, gas = ETH, mainnet chain ID **4663** | Anyone deploys Solidity/Vyper; no allowlist |
| **ERC-8056 stock tokens** | Robinhood's tokenized equities; `uiMultiplier()` handles splits/dividends without rebase | **Mint KYB-gated to Authorized Participants — we only read/transfer/compose** |
| **ERC-6551** | Gives each Broker its own wallet; canonical registry `0x000000006551c19487814612e58FE06813775758` (bytecode-verified ✓) | Standard account impl **not deployed on RH Chain — we deploy our own** |
| **Uniswap v3 + v4** | Booster uses the protocol's validated two-hop StockRouter across Rialto/v3 venues; $COAT launches directly on canonical v4 | v4 PoolManager `0x8366…0951`, PositionManager `0x58da…4fa7` (see ADDRESSES.md) |
| **Chainlink feeds** | Per-stock price oracle (corporate-action adjusted) — used for **Booster slippage guards only**, not mint (mint is flat ETH) | Read-only; ~33 stock feeds, **no ETH/USD feed** |

**Coverage (194 active canonical RH-Chain stock tokens at the 2026-08-15 snapshot):** Congress's
most-traded names — NVDA, MSFT, AAPL, AMZN, TSLA, GOOGL, META, AVGO, AMD, CRM, PLTR, COIN,
PANW and LMT — are tokenized. Against the bundled recent-disclosure sample the indexer measures
canonical-token coverage. The current product scope intentionally permits only the independently
proven five-route intersection; no unguarded or unprobed stock can enter a basket. The production
V1 deliberately limits its product universe to five independently route-probed stocks: AAPL, AMD,
AMZN, COIN and CRCL. The remaining canonical addresses are discovery data, not an obligation to buy.
The production basket must remain limited to the **tokenizable, liquid, route-ready V1 intersection**;
a canonical token address alone does not prove that a safe swap route exists.

**Risk reality:** Robinhood Stock Tokens are third-party tokenized instruments. Availability, transferability and venue access may depend on issuer terms and applicable law. See §9.

---

## 4. The product

### The unit: a Broker
An NFT (ERC-721) permanently bound to the **Politician** strategy, with its own ERC-6551 wallet. A Broker has two states:
- **Inactive** (fresh from mint) — it owns a wallet but earns nothing yet.
- **Active** — its owner has **burned $COAT to switch it on**; it accrues claimable stock-token rewards matching the latest valid disclosed-Congress basket.

**Transferring an active Broker turns it back off.** Unclaimed entitlement remains keyed to the token ID. Assets already claimed into the TBA move to the buyer only if the seller leaves them there; withdrawn assets naturally do not. The buyer must burn $COAT to re-activate and resume earning.

### v1 ships ONE strategy: The Politician
The whole collection = "follow Congress." Razor-sharp promise, best data-fit, fastest launch. The architecture keeps a `strategy` trait so future strategies (**The Innovator/ARK** is the top candidate — tech-heavy, daily holdings; then The Whale, The Insider) can be added to the same collection **via governance without redeploying.**

### The collection
- **Supply: 1,776 Brokers** (1776 = US independence — thematic with Congress; scarce = prestige).
- **Primary mint cap: 2 per address.** Secondary transfers may result in one wallet owning more than two.
- Token IDs are drawn without replacement from `1..1776` using a sparse Fisher–Yates pool. A two-NFT transaction returns two different IDs, and sellout is a complete permutation. The entropy is immediate pseudo-random block entropy, not VRF; the sequencer may influence it.
- Single ERC-721 collection; every Broker mints with an ERC-6551 wallet auto-deployed via the canonical registry.
- **Art: 1-bit PFP portraits stored and rendered on-chain.** All 1,776 accepted local assets consist of a 40×40 monochrome bitmap (200 bytes), 8-byte traits and retained source PNG. Storage/rendering becomes on-chain only after batch upload and `setRenderer` wiring.
- **Exact metadata distribution:** Alien 2, Ape 4, Zombie 16, Female 681 and Male 1,073. Public metadata uses seven categories with fixed collection-wide counts. The 22 rare-Type outputs were manually approved. The allocator guarantees at least one non-None optional metadata trait, but the bitmap quality gate cannot semantically prove that FLUX rendered every assigned secondary trait; a final trait-fidelity spot-check remains before upload.
- **Rarity** comes from the published exact trait counts, combinations and accrued stock holdings. The prompt vocabulary is natural PFP portraiture; collection lore does not force suits, finance uniforms, antennas or horns into the art.
- **Generation:** off-chain pipeline (`pipeline/`) — deterministic trait→prompt, Flux 2 Klein via Replicate, binarized to the on-chain 200-byte format, with a density/interior-detail quality gate. ~$2 for the full 1,776. See `pipeline/README.md`.

---

## 5. How a Broker works (user journey)

1. **Mint a Broker** — **0.001 ETH** (the owner may only lower this, down to a free mint; it is never raised). Mint proceeds go **directly to the creator**. The Broker gets its **ERC-6551 wallet** automatically, but starts **inactive**.
2. **Activate it** — buy $COAT from the v4 pool and **burn `36,750 COAT`**. Each token ID is independent: two active NFTs cost `73,500 COAT` and earn two equal shares; one active NFT earns one share.
3. The **Politician strategy has live target weights** (e.g. 22% NVDA, 15% MSFT, 11% AAPL…), refreshed as new congressional disclosures land.
4. **Fee pool buys real stock.** The staged keeper advances `CoatFeeHook.flush → FeeSplitter.flush`; **80% reaches the Booster**, and an eligible permissionless `poke()` buys the target basket. Purchases create pro-rata `claimable` balances; they do not push 1,776 wallet transfers.
5. **Rebalance.** When Congress's disclosed portfolio shifts, on-chain target weights update (oracle, §6); new purchases follow new weights.

If no new disclosure arrives, purchases do not pause: fee-funded buys continue
against the last valid on-chain basket. A later valid update changes only future
purchase weights; stocks already attributed to Brokers are not sold or rebalanced.
6. **Claim, withdraw or sell.** The owner claims from Booster into the Broker TBA, may withdraw through the TBA, or sells it with any holdings left intact. The buyer re-burns $COAT to resume earning.

**Net:** holding an active Broker = passively accumulating a real, tokenized, auto-updating copy of what Congress bought — funded by the collection's own trading.

---

## 6. The oracle (the hard part)

Congressional trades are **off-chain** (STOCK Act disclosures). Bringing them on-chain correctly is the central engineering + trust challenge.

```
STOCK Act disclosures (Capitol Trades / Quiver / Unusual Whales)
      │  our off-chain indexer ingests
      ▼
Normalize → map each holding to a Robinhood Chain stock-token address
      │  DROP untokenized names; renormalize weights to 100%
      ▼
Sign the target-weight vector (per epoch)
      │  signed feed now → Chainlink Functions / decentralized keeper later
      ▼
On-chain StrategyRegistry stores target weights
      │
      ▼
Booster reads weights → buys basket on Uniswap → credits claimable balances → owner claims to TBA
```

**Trust model (disclosed honestly):**
- The indexer is a **trusted component** in v1. Mitigations: publish exact sources + mapping rules; make weight updates transparent and challengeable; open-source the indexer so anyone can verify a posted vector against public filings; migrate to Chainlink Functions / decentralized keepers over time. **We will not market it as "trustless" until it is.**
- **Latency:** congressional disclosures lag up to ~45 days. Brokers track *disclosed* positions, not real-time — framed openly as a feature ("what they filed"), not hidden.
- **Coverage transparency:** publish live coverage % (tokenizable weight ÷ full disclosed weight).

---

## 7. The flywheel (economic engine)

```
Revenue: $COAT swap fees (CoatFeeHook, the primary engine)
      │   [mint proceeds do NOT flow here — they go straight to the creator]
      │
      ├─ 80% → Booster → buys the Politician basket → active-token claimable ledger
      ├─ 10% → Project treasury (oracle infra, dev, audit — funds the project's future, not the creator)
      └─ 10% → $COAT buyback & burn
```

The `CoatFeeHook` skims 1%: **sells** accrue ETH for the FeeSplitter and **buys** accrue COAT which is sent through `COAT.burn()`. Buy fees, activation and the TWAP buyback therefore all reduce `totalSupply`.

**Automation policy.** Contracts do not wake themselves; transactions are required:
- An independent hourly keeper advances hook flush, splitter flush, eligible `poke`, and threshold/TWAP-eligible buyback stages.
- Every stage is permissionless, so a third party can recover progress if our keeper is down; fees otherwise remain buffered for the next run.
- Congress data failure blocks only a new basket update. Purchases continue against the last valid basket.
- Bought stock is accounted pull-first through `accPerShare / activeShares`; the owner claims it into the TBA.

**Honest framing:** rewards are **volume-funded, not guaranteed yield.** If trading volume dies, the Booster has nothing to spend. This is a fee-recycling mechanism, not a promise of return.

**Activation, not tiers.** v1 uses a single binary switch (active/inactive) — one share per active Broker, no multiplier tiers. Weighted burn-for-multiplier tiers can be added later without changing the accumulator math.

---

## 8. Tokenomics

### $COAT (ERC-20, Robinhood Chain)
- **Utility:** the **activation currency** — burned to switch a Broker on (and to re-activate after any transfer). This is the token's core, recurring demand driver and its main deflationary sink. Plus governance (add/retire strategies, tune fee splits) and the fee buyback/burn target.
- **Total supply: 1,000,000,000 $COAT** (fixed; mint-once; burnable). Activation is a pure sink — nothing is ever handed out, so there is no distribution to dump.
- **Activation cost:** immutable **36,750 COAT** per activation. Full-collection first activation burns **65.268M COAT (6.5268% of initial supply)**, compounding with every resale.
- **Distribution (fair launch, zero-capital):**
  - **100% (1B, less only token-wei rounding burned)** → Uniswap **v4 single-sided liquidity** launch range
  - No presale, VC, reserve or **team/creator token allocation**. The LP NFT is permanently locked.

### Single-sided (one-sided) launch — why & how
We have **no capital to seed a pool**, so we deposit **only $COAT** (no paired ETH) into a Uniswap v4 concentrated range *above* the starting price ([single-sided liquidity](https://support.uniswap.org/hc/en-us/articles/20902968738317-What-is-single-sided-liquidity)). As buyers arrive they buy $COAT out of the range and leave ETH behind — a **bonding-curve-style fair launch** that needs zero ETH from us and accumulates real paired ETH principal. That principal is permanently locked; only accrued LP fees can be collected to treasury.
- Mechanics: [create-pool](https://developers.uniswap.org/docs/protocols/v4/guides/create-pool) with a chosen `PoolKey` (currencies, fee, tickSpacing, hooks) + [Position Manager](https://developers.uniswap.org/docs/protocols/v4/guides/position-manager) `mint` of a single-sided range.
- The **`CoatFeeHook`** accrues 1% of each swap. A permissionless `flush()` transaction routes it onward; the hourly keeper supplies that transaction.
- **Confirmed on-chain (bytecode-verified):** canonical Uniswap v4 is deployed on chain 4663 — PoolManager `0x8366…0951`, PositionManager `0x58da…4fa7`, Universal Router, StateView and V4Quoter (see ADDRESSES.md). The current design launches directly through these contracts with `LaunchWithHook.s.sol`.
- **Required launch protection:** the two blocks after activation enforce a maximum 5% recipient holding and 5.5% aggregate swap-output buy; the activation block rejects buys. Sales remain unrestricted, while wallet transfers remain available within the temporary 5% ceiling. The mandatory hook checks the full v4 `BalanceDelta`, and COAT checks PoolManager output plus forwarded recipients, so neither fragmented `take` settlement nor an alternate router bypasses the limits. A Pons-style V3 factory remains a comparison, not an automatic migration decision.
- **Graduation is locked:** show progress toward `4.2 ETH` of genuine paired principal and mark the launch graduated at the threshold. It is a status milestone only; it does not migrate liquidity or change the canonical pool.
- **Price is locked:** `1e-8 → 1e-6 ETH/COAT`; activation is immutable at `36,750 COAT`.
- **Sequencing:** $COAT must be launched and liquid *before* activation opens, since activating requires buying and burning $COAT.

### Broker NFT economics
- **Supply 1,776**, art = **1-bit on-chain PFP portraits** — exact Alien/Ape/Zombie/Female/Male and accessory distributions (see §4 The collection), rendered as 40×40 200-byte on-chain bitmaps.
- **Mint price = 0.001 ETH, owner-lowerable only** (down to free; never raised — RH Chain's gas token is ETH, no Chainlink needed). The sellable supply can also be cut downward and a buyer refunded for a problem mint (owner-funded ETH; the NFT is untouched). Mint proceeds go to the creator. ERC-2981 reports a fixed **2.5% secondary royalty directly to the current creator**. The real "cost" of a working Broker is the **COAT activation burn**, which scales naturally with COAT's market value.
- **Primary-distribution guard:** per-wallet mint cap 2. It does not restrict secondary-market ownership.
- **Bootstrap liquidity** comes from the $COAT single-sided launch as buyers acquire $COAT. Royalties are creator revenue and do not fund the flywheel.
- The Broker's value = its ERC-6551 stock holdings + expected future reward flow (if kept active) + collectible/scarcity premium.

---

## 9. Legal / risk (do not skip)

- **Financial and regulatory risk is real.** The system interacts with third-party tokenized instruments and does not guarantee returns. Users are responsible for understanding applicable rules and third-party terms; this document makes no universal compliance claim.
- **Name/likeness:** congressional trade *data* is public and legal to republish; we use the descriptive name **"The Politician,"** never a specific person's name/likeness, and **never imply endorsement.**
- **"Robinhood" branding:** the chain is real and Robinhood-operated, but we are an independent third party — **no affiliation/endorsement implied.**
- **Oracle centralization:** disclosed in §6; not marketed as trustless until decentralized.
- **Data-source ToS:** use compliant sources (SEC EDGAR is public; Capitol Trades / Quiver / Unusual Whales have terms).
- **No guaranteed yield:** rewards are volume-funded; communicate this everywhere.

---

## 10. Technical architecture (sketch)

- `CoattailBroker` (ERC-721) — the collection; 0.001 ETH mint (→ `creator`, owner-lowerable to free) deploys an ERC-6551 account via the canonical registry. `activate(tokenId)` burns COAT and flips the Broker on; `_update` (transfer hook) flips it off and notifies the Booster.
- `StrategyRegistry` — `strategyId → { tokenAddresses[], targetWeights[], epoch }`; **EIP-712 signed** weight vectors (`setStrategyWithSig`, monotonic epoch, per-epoch drift cap) with an AccessControl role fallback.
- `Booster` — receives fee ETH, market-buys through the validated two-hop `StockRouter`, and credits active token IDs pro-rata (`accPerShare / activeShares`). Owner `claim(tokenId)` moves whole raw-token amounts into the TBA.
- `COAT` (ERC-20, burnable) + its Uniswap **v4** single-sided launch. `AtomicV4Launcher` makes hook deployment, guarded initialization, LP ID binding and permanent-locker mint one transaction.
- `CoatFeeHook` — Uniswap **v4** hook; accrues 1%/swap, burns buy-side COAT directly and permissionlessly flushes sell-side ETH → FeeSplitter.
- `FeeSplitter` — routes swap-fee ETH 80/10/10 (Booster / project / buyback). ERC-2981 royalties go directly to the creator.
- `BrokerAccount` — our own ERC-6551 account implementation (the standard one isn't on RH Chain).
- `BrokerRenderer` — fully on-chain 1-bit art + trait metadata for `tokenURI`.
- Composes with RH Chain **ERC-8056 stock tokens** (read/transfer only) + their Chainlink feeds (Booster slippage guards).

All contracts are deployable permissionlessly. That technical property is not a legal or regulatory conclusion. We deploy **our own ERC-6551 account implementation** (the standard one isn't on RH Chain).

---

## 11. Release status

Design decisions and completed verification are summarized in `STATUS.md`, which is the only
canonical release-blocker list. Post-launch product possibilities such as additional strategies
or living-portfolio art are not part of the v1 GO gate.

---

## 12. Decisions log

**Resolved:** Smart-Money-Mirror concept · fee→stock flywheel · **The Politician only (v1)** · single collection, strategy=trait · **permissionless staged automation** · **$COAT via Uniswap v4 single-sided** · name **Coattail Brokers** · supply **1,776** · five independently route-probed V1 stocks · art = **1-bit on-chain PFPs, five Type categories, slate-on-cream**, Flux Klein + quality gate.

**Implemented mint/COAT model:** **mint = 0.001 ETH → creator (owner-lowerable to free)** plus **2.5% ERC-2981 royalty → current creator** · immutable **36,750 COAT activation burn** · transfer deactivates · Booster active-share weighted with guarded, route-ready stock purchases · FeeSplitter 80/10/10 · permissionless TWAP buyback · full 1B launch allocation with no reserve/team tokens · canonical v4 launch with permanent LP custody and Pons-inspired first-three-block protection.

**Historical testnet proof:** the earlier deployment established the ERC-6551, signed-basket, activation/deactivation, selected reward-claim and v4 fee-routing mechanics. Those addresses are retired; they are not release evidence for the new clean deployment.

**Still open (pre-mainnet):** the authoritative live list is only `STATUS.md`. The principal gates are the 888-wallet transaction run, a clean market-hours mainnet-fork release report, the renderer read-back sweep, and production key/provider configuration. A wallet-backed frontend E2E is **not** a gate (project decision, 2026-08-16): frontend correctness rests on the contract tests, the render-level E2E suite and a manual pre-launch click-through. The target key model separates a hardware-wallet owner from distinct deployer, keeper and oracle keys; today only a deployer key exists, so creating those production identities is part of the configuration gate.

---

*V1 release specification — locked economic constants are enforced in code. Not financial or legal advice.*
