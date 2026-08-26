# The Desk — Locked Specification (v1)

> Community vote: Mirror Accounts round closed 2026-08-25 (7 voters), The Desk round passed
> 2026-08-26 with 13 votes. Decisions below are LOCKED; changes require a new community round.
> Build constraint: everything lives in this `desk/` folder. The deployed core
> (`contracts/`, indexer, keeper) is not modified; Desk contracts only READ it.

## Product

Open a Desk, deposit USDG, and the same engine that runs Broker payroll buys the live
Congress basket into YOUR desk wallet. Withdraw anytime, revoke anytime, or sell the
Desk NFT whole with the portfolio inside.

## Locked decisions

| Decision | Value | Source |
|---|---|---|
| Supply | **Waved: pilot 500, then mint closes; owner may reopen later waves on demand via settable `mintCap`; hard ceiling `MAX_DESKS = 2000` (constant, forever)** | user 2026-08-26 |
| Mint price | **120,000 COAT**, settable | user 2026-08-26 (was 100k proposal) |
| Mint COAT destination | **No burn.** 100% to CoatBonusPool, distributed to ACTIVE Brokers | user |
| Service fee | **0.5%** per engine-executed trade, settable | community vote 6/7 |
| Fee split | **80% Booster / 20% treasury**, settable (no buyback slice) | user 2026-08-26 |
| Booster share | converted to **native ETH** before sending (Booster ignores ERC-20) | Zia lesson |
| Pilot cap | **$1,000 deposit per Desk**, settable | community vote 6/7 |
| Pilot access | **Open to everyone from day one** | user 2026-08-26 (overrides the 5/7 holders-first vote; communicate in next community update — holders still gain via mint-COAT bonus) |
| Holder fee discount | **None** (fee stream stays whole) | community vote 4/7 |
| Deposit minimum | **None** ($20 desks welcome) | thread promise |
| Deposit currency | **USDG** (stock pools are USDG-paired; single-hop buys) | design |
| Custody | per-Desk **ERC-6551 wallet** bound to the Desk NFT | user |
| Art | on-chain SVG pixel desk; visual traits FIXED at mint; live data as `display_type: number`, rounded | user + rarity-churn lesson |
| Rebalance | on deposit + on epoch change (not hourly) | design |
| Main-collection isolation | separate contracts; Broker rarity untouched | user |

## Contracts (all new, all in `desk/src/`)

1. **CoatBonusPool** — receives mint COAT; keeper posts merkle rounds computed over the
   ACTIVE Broker set at distribution time; anyone can claim a Broker's share into that
   Broker's existing 6551 wallet (assets follow the NFT, same as salary). Owner can sweep
   only COAT that is not allocated to any round. Also a permanent rail for future COAT
   flows to active Brokers (partner contributions, campaigns).
2. **DeskNFT** — ERC-721, 500 cap, mint pulls COAT to the bonus pool, deploys the Desk's
   6551 account (canonical registry), renders on-chain SVG via DeskRenderer.
3. **DeskAccount** — 6551 account implementation for Desks: identical control model to
   BrokerAccount (owner-only execute) plus a standing, revocable authorization for the
   DeskEngine restricted to engine operations (pull USDG up to cap, deliver stocks).
4. **DeskEngine** — executes buys/rebalances: pulls USDG from a Desk, swaps through the
   allowlisted USDG stock pools with Chainlink `minOut` guards (same guard math as
   Booster), returns stock to the same Desk, takes the 0.5% fee, splits 50/30/20 and
   converts the Booster share to native ETH.
5. **DeskRenderer** — on-chain SVG + metadata (fixed traits; live holdings via
   `display_type: number`).

Reads from the deployed core (interfaces only, no modifications):
`Booster.isActive/activeShares` (bonus eligibility), `CoattailBroker.ownerOf/accountOf`
(claim destination + pilot gating), `StrategyRegistry.getBasket` (composition),
Booster stock feeds pattern for price guards.

## Trait system (the rarity-churn problem, solved before mint)

Two structural guarantees, designed so the Brokers rarity-churn failure CANNOT recur:

1. **Fixed traits are curated off-chain for ALL 2,000 ids at once** (`art/traits_gen.py`,
   deterministic seed `THE.DESK.TRAITS.V1`): exact counts per option (no hash luck), zero
   exact-duplicate scenes by construction, and wave 1 (ids 1-500) tracks the global rarity
   proportions. The full table is uploaded on-chain before wave 1 and its sha256 digest
   (`ac7a3505bb56a310437661d2447654d315d788a46eb5680e202c8efe192efa50`) is published, so
   later waves are provably pre-committed — nobody can rig Desk #1777's traits after seeing
   demand. Seven axes: wall (9) · wood (5) · screens (3) · chart direction (2, red 10%) ·
   gadget (4, gold calculator 5%) · companion (5, cat 8%) · accent color (6). 32,400 scene
   space for 2,000 desks.
2. **Live data never enters the trait list.** Holdings/value/age appear only as
   `display_type: number`, rounded — rarity engines exclude those by spec. Attributes that
   rank a Desk are frozen at upload, forever; a claim or rebalance can refresh the image,
   never the rank.

## Trust & safety invariants

- User funds live only in the user's Desk wallet; no pooled custody anywhere.
- The engine can only: pull USDG within the user-set cap, deliver purchased stock back
  to the same Desk, and take the published fee. It can never redirect assets elsewhere.
- Every price-sensitive swap is guarded by Chainlink-derived `minOut` (Booster's math).
- Every parameter that could need tuning ships settable (the 36,750 lesson); the 500
  supply cap and the "no pooled custody" model are the only constants.
- CoatBonusPool can never touch COAT already allocated to a posted round.

## Build order

1. CoatBonusPool (independent, testable now) ← **done, 7 tests green**
2. **Art preview FIRST** (user gate): DeskRenderer SVG drafts shown to the user before
   anything ships; art direction locked before mint flow is finalized
3. DeskAccount + DeskNFT (mint flow end-to-end on fork)
4. DeskEngine (fork tests against real USDG pools)
5. **Full testnet deployment (chain 46630)**: every contract deployed and every flow
   (mint, deposit, buy, rebalance, fee split, bonus round, withdraw, desk sale) exercised
   on testnet BEFORE any mainnet transaction (user gate, 2026-08-26)
6. Lawyer one-pager BEFORE any mainnet deploy (open item)
7. Mainnet only after 5 + 6 are signed off
