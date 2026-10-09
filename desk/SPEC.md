# The Desk — Locked Specification (v1)

> Community vote: Mirror Accounts round closed 2026-08-25 (7 voters), The Desk round passed
> 2026-08-26 with 13 votes. Decisions below are LOCKED; changes require a new community round.
> Build constraint: everything lives in this `desk/` folder. The deployed core
> (`contracts/`, indexer, keeper) is not modified; Desk contracts only READ it.
>
> **Status 2026-10-09: ready for the mainnet broadcast.** Built, audited, deployed and run on
> testnet, the mainnet deploy rehearsed on a fork. The current step, the launch parameters and the
> runbook live in [STATUS.md](STATUS.md). (Frozen 2026-08-28 for Playbooks, resumed 2026-08-31.)

## Product

Open a Desk, deposit USDG, and the same engine that runs Broker payroll buys the live
Congress basket into YOUR desk wallet. Withdraw anytime, revoke anytime, or sell the
Desk NFT whole with the portfolio inside.

## Locked decisions

| Decision | Value | Source |
|---|---|---|
| Supply | **All 2,000 Desks mintable from day one** (no waves); `mintCap` stays settable below the hard ceiling `MAX_DESKS = 2000` (constant, forever). First plan was waves of 500 | user 2026-08-26, 2026-10-07 |
| Mint price | **120,000 COAT**, settable | user 2026-08-26 (was 100k proposal) |
| Mint COAT destination | **No burn.** 100% to CoatBonusPool, distributed to ACTIVE Brokers | user |
| Service fee | **0.5%** per engine-executed trade, settable | community vote 6/7 |
| Fee split | **100% Booster**, settable (treasury share 0; was 80/20 until 2026-10-07; no buyback slice) | user 2026-08-26, 2026-10-07 |
| Booster share | converted to **native ETH** before sending (Booster ignores ERC-20) | Zia lesson |
| Deposit cap | **None** (user 2026-10-07: "pilot cap olmasın", anyone deposits what they like). The engine still keeps the per-Desk book (`principal` = deposits through the router minus what the owner takes out, valued when it leaves; `usdg` = booked deposits plus the engine's own sell proceeds), and an optional cap stays a lever (`setDepositCap`, default `type(uint256).max` = none); if ever set, a deposit that would take principal over it reverts, profit and loss never count. History: the pilot shipped with $1,000 (community vote 6/7); v1 counted cumulative spend, v2 value, v3 cost, v4 principal (2026-09-28), lifted 2026-10-07 | community vote 6/7, user 2026-09-28, 2026-10-07 |
| Pilot access | **Open to everyone from day one** | user 2026-08-26 (overrides the 5/7 holders-first vote; communicate in next community update — holders still gain via mint-COAT bonus) |
| Holder fee discount | **None** (fee stream stays whole) | community vote 4/7 |
| Deposit minimum | **None** ($20 desks welcome) | thread promise |
| Deposit currency | **USDG, ETH or COAT** via `DeskDepositRouter` (converted to USDG in the same tx, lands in the Desk wallet; ETH floored by Chainlink ETH/USD, COAT sold through the live COAT router so the hook skim still funds the Booster). COAT deposits are sell pressure on COAT, accepted knowingly | user 2026-09-27 |
| Custody | per-Desk **ERC-6551 wallet** bound to the Desk NFT | user |
| Art | on-chain SVG pixel desk; visual traits FIXED at mint; live data as `display_type: number`, rounded | user + rarity-churn lesson |
| Rebalance | on deposit + on epoch change (not hourly) | design |
| Main-collection isolation | separate contracts; Broker rarity untouched | user |

## Contracts (all new, all in `desk/src/`)

1. **CoatBonusPool** — receives mint COAT; keeper posts merkle rounds computed over the
   ACTIVE Broker set at distribution time; anyone can claim a Broker's share into that
   Broker's existing 6551 wallet (assets follow the NFT, same as salary). Owner can sweep
   only COAT that is not allocated to any round. Also a permanent rail for future COAT
   flows to active Brokers (partner contributions, campaigns). COAT can never be swept: it
   leaves only through posted rounds (audit 2026-10-02; the owner may still recover other
   stray tokens).
2. **DeskNFT** — ERC-721, settable `mintCap` (2,000 by default) under a constant `MAX_DESKS = 2000`
   ceiling, mint pulls COAT to the bonus pool, deploys the Desk's
   6551 account (canonical registry), renders on-chain SVG via DeskRenderer.
3. **DeskAccount** — 6551 account implementation for Desks: identical control model to
   BrokerAccount (owner-only execute) plus a standing, revocable authorization for the
   DeskEngine restricted to engine operations (pull USDG up to cap, deliver stocks).
4. **DeskEngine** — executes buys/rebalances: pulls USDG from a Desk, swaps through the
   allowlisted USDG stock pools with Chainlink `minOut` guards (same guard math as
   Booster), returns stock to the same Desk, takes the 0.5% fee and sends it to the Booster as
   native ETH (a treasury share is settable, 0 by default).
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
- Every price-sensitive swap is guarded by Chainlink-derived `minOut` (Booster's math),
  including the fee conversion to ETH (Chainlink ETH/USD, `setEthUsdFeed`).
- Every swap is exact-in: the pool must take the whole input in one callback payment, and the
  output is measured on the recipient's balance, never taken from the pool's report.
- The engine only sells shares it bought (`heldQty`). Shares or USDG the owner puts in the
  wallet any other way are never traded, so the book (and any deposit cap) cannot be walked around.
- A stale or missing price never locks a Desk: withdrawals are valued leniently (stale counts,
  no feed frees nothing); only buying waits for a fresh price.
- A basket name without a USDG pool is skipped and the rest keep their relative weights.
- Every parameter that could need tuning ships settable (the 36,750 lesson); the 2,000
  hard ceiling and the "no pooled custody" model are the only constants.
- CoatBonusPool can never touch COAT already allocated to a posted round.

## Build order

1. CoatBonusPool (independent, testable now) ← **done, 7 tests green**
2. **Art preview FIRST** (user gate) ← **done 2026-08-31: 16 real wave-1 desks rendered
   from the curated table, user approved; DeskRenderer.sol shipped with byte-for-byte
   parity fixtures against the Python reference (scene_gen.py), 6 renderer tests green,
   traits keccak commit `0xa9ca0d1af9e49f121368ad423a74c685ede94ca1cf3bdf7591b7f24b7016974e`**
3. DeskAccount + DeskNFT (mint flow end-to-end on fork) ← contracts done, 19 tests green
4. DeskEngine (fork tests against real USDG pools) ← **done 2026-09-19: `desk/test/ForkDeskEngine.t.sol`
   deploys all four contracts on a mainnet fork, opens a desk, funds it with USDG and runs the live
   basket (INTC/MSFT 50/50, epoch 58) through the real v3 USDG pools with the Booster's Chainlink
   feeds as floor. Fills landed at 10001 bps (INTC) and 9991 bps (MSFT) of oracle; sell-back,
   0.5% fee flush to the Booster as native ETH (80/20), the $1,000 pilot cap and the owner's
   pause all hold. 5 fork tests, 30 desk tests total.** Note: the 7 Rialto-routed names have no
   v3 USDG pool; the Desk universe is the 26 v3 names until a RialtoLeg-style adapter is added.
5. **Full testnet deployment (chain 46630)** ← **done.** Dress run on an anvil fork 2026-09-27
   (`script/rehearse_local.py`, testnet-only venue in `src/testnet/DeskTestVenue.sol`, own
   StrategyRegistry slot), real broadcasts v1 2026-09-28, v2 2026-10-02 (principal book), v3
   2026-10-02 (audited); the founder tested mint, deposit, cap, P&L and withdrawals by hand.
   Along the way: `buyStock` for targeted rebalances (2026-09-27: 0.40% instead of 1.32% for a
   30% move), the 96h stock-feed window (weekend trading), deposits in ETH and COAT.
6. ~~Lawyer one-pager~~ dropped by the founder (2026-10-02). Replaced by the **internal audit**
   ← done 2026-10-02 ([AUDIT-2026-10-02.md](AUDIT-2026-10-02.md)): 7 fixes, invariant suite,
   `script/check_deployed.py` (23/23 against the deployed testnet set).
7. **Mainnet** ← script ready and rehearsed (2026-10-07): `script/DeployDeskMainnet.s.sol`,
   26/26 on a mainnet fork. Launch changes the founder made on 2026-10-07: fee split 100%
   Booster, no deposit cap, no mint waves (2,000 from day one), the Booster's keeper relay. Next:
   confirm the mint price, broadcast, then the post-deploy list in [STATUS.md](STATUS.md).
