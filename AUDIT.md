# Coattail Brokers — Security Audit (internal)

_Internal review record. Initial review: 2026-08-14; documentation reconciled: 2026-08-15. Commit-specific findings below are historical unless marked current._
_Scope: all in-house Solidity in `contracts/src` (excludes `lib/` OpenZeppelin and canonical Uniswap v4 / ERC-6551 code, which are treated as trusted dependencies)._

> **2026-08-15 update:** the hardcoded single-hop router finding is fixed by the
> in-repo two-hop `StockRouter`, and LP custody moved to `PermanentV4LiquidityLocker`.
> The initial mainnet fork returned `ACF` because Foundry used the RPC L2 height for
> `BLOCKNUMBER`, while Rialto Fermi freshness uses Arbitrum's L1 block number. After restoring
> the live L1 value in the fork, the in-repo router successfully bought all five manifest stocks.

> **This is an internal engineering review, not a substitute for a paid third-party audit before mainnet.** It reflects a careful manual read of the value-carrying contracts; it did not run symbolic execution or fuzzing beyond the existing test suite.

## Files reviewed
`CoattailBroker.sol` · `Booster.sol` · `StrategyRegistry.sol` · `CoatFeeHook.sol` · `FeeSplitter.sol` · `BuybackBurner.sol` · `CoatRouter.sol` · `COAT.sol` · `BrokerAccount.sol` · `BrokerRenderer.sol` · `interfaces/IExternal.sol`

## Summary

Overall the code is careful: pull-based reward accounting (no 1,776-wallet loops), CEI ordering in the sensitive mutators, `ReentrancyGuard` on `Booster.poke/claim`, permissionless flush/poke/buyback so a downstream failure can never brick trading, EIP-712 replay/reorder protection, and a faithful ERC-6551 account. **No critical/fund-draining bug was found in normal operation.** The findings below are two real HIGH issues (both fund-lock / liveness, not theft), a handful of MEDIUM correctness/robustness items, and low/informational notes.

| # | Severity | Contract | Title | Status |
|---|---|---|---|---|
| H-1 | High | Booster | Empty-basket `poke()` permanently strands the ETH buffer as unrecoverable WETH | ✅ Fixed |
| H-2 | High | Booster | Unbounded `knownTokens` iteration → active Brokers can become non-transferable | ✅ Fixed |
| M-1 | Medium | FeeSplitter | Atomic 3-way `flush()` couples distribution liveness; `setSinks` has no safe-receiver guard | ✅ Fixed |
| M-2 | Medium | Booster | Slippage guard leans on a 1-day-stale manual ETH price / `allowUnguarded` zero floor | ✅ Fixed |
| M-3 | Medium | StrategyRegistry | No rejection of zero-address tokens, duplicates, or per-element zero weights | ✅ Fixed |
| M-4 | Medium | Booster | Fractional reward remainder is discarded on claim; dust has no sweep | ✅ Fixed |
| L-1 | Low | CoattailBroker | `mint(0)` with ETH attached returns without refunding | Open |
| L-3 | Low | CoatFeeHook | `afterSwap` reverts if `stateView.getSlot0` reverts → trading liveness coupled to a dependency | Open |
| L-4 | Low | CoattailBroker | Burning an active Broker would not deactivate it in Booster (latent; no burn fn today) | Open |
| L-5 | Low | BrokerRenderer | `tokenURI` reverts for un-uploaded tokens; wiring the renderer before a full upload breaks their metadata | Open |
| L-6 | Low | FeeSplitter/Booster | Owner setters lack zero-address checks | Open |
| I-1 | Info | — | Single dev-wallet controls every owner/admin role (accepted design) | Accepted |
| I-2 | Info | StrategyRegistry | `oracleSigner` is a trusted centralized oracle (disclosed) | Accepted |
| H-3 | High | StockRouter / Rialto | Fork-only L1/L2 block-number mismatch produced `ACF` | ✅ Resolved — five live routes pass |
| I-3 | Info | Booster | Hardcoded single-hop/fee route | ✅ Fixed — per-token two-hop StockRouter |

---

## HIGH

### H-1 — Empty-basket `poke()` permanently strands the ETH buffer as WETH
**`Booster.poke()` (src/Booster.sol:188)**

```solidity
if (totalShares == 0) return;          // guards the no-active-share case
weth.deposit{value: buffer}();         // wraps the ENTIRE buffer first
weth.approve(address(router), buffer);
for (uint256 i; i < tokens.length; ++i) { ... }   // but only spends per-token slices
```

`poke()` wraps the whole ETH buffer into WETH **before** the swap loop. If the live basket is empty (`tokens.length == 0`) while `activeShares > 0`, the loop body never runs, nothing is swapped, and the full buffer is now WETH sitting in the Booster. **The Booster has no `withdraw`/unwrap path** (the `IWETH` interface doesn't even import `withdraw`), and every subsequent `poke()` reads `address(this).balance` (native ETH), so the wrapped ETH is invisible and **permanently lost**.

Reachability: `poke()` is permissionless. A Broker can be activated (→ `activeShares > 0`) before the first basket is posted, since `Booster.activate` only loops `knownTokens`. Anyone can then call `poke()` once the buffer ≥ `pokeThreshold`. This is a real bootstrap-window risk, and the same root cause silently accretes wei-dust WETH even in normal operation.

**Fix:** guard early — `if (tokens.length == 0) return;` before wrapping — and add an owner-only `sweepWeth()` (or unwrap-and-forward) so any stranded/dust WETH is recoverable. Add `withdraw(uint256)` to the `IWETH` interface.

> **✅ Fixed (2026-08-14).** `poke()` now returns before wrapping when the basket is empty, and prices the per-token slices first so it wraps **only** what it spends — the rounding remainder stays as native ETH and rolls into the next poke. Added owner-only `sweepWeth(to)` plus `IWETH.withdraw/balanceOf` as a safety valve for any legacy/stray WETH. Regression tests: `test_H1_poke_strandsNoWeth`, `test_H1_emptyBasket_returnsBeforeWrapping`, `test_H1_sweepWeth_recoversStrandedWeth`, `test_H1_sweepWeth_onlyOwner`.

### H-2 — Unbounded `knownTokens` iteration can make active Brokers non-transferable
**`Booster.activate/deactivate/claim` (src/Booster.sol:155,172,216)**

All three loop over `knownTokens`, which only ever grows (`_trackToken` never removes). As the basket rotates across months of epochs, this array grows without bound. The dangerous one is `deactivate()`: it is invoked from `CoattailBroker._update` on **every transfer of an active Broker**. Once `knownTokens` is large enough that the loop exceeds the block gas limit, transferring an active Broker reverts — the NFT becomes **stuck/non-transferable** unless first deactivated, and deactivation runs the same loop. `activate()` (blocking new activations) and `claim()` (blocking withdrawals) degrade the same way.

**Fix:** bound the working set to the *current* basket rather than all-history. Options: iterate `registry.getBasket` tokens in claim/activate/deactivate instead of `knownTokens`; or snapshot per-token accounting so stale tokens with a zeroed `accPerShare`-delta can be skipped/pruned; or cap basket cardinality and retire tokens that fully exit.

> **✅ Fixed (2026-08-14).** Chose the low-risk, zero-accounting-change option: a hard cap `MAX_KNOWN_TOKENS = 128`, enforced in `_trackToken`. Every reward loop is now deterministically bounded (≤128), so `deactivate()` inside the transfer path can never run out of gas. The tokenizable Congress universe is small and stable (~40–60 mega-cap names), so the cap is comfortable; if v1 ever exhausts it, `poke()` reverts `TokenCapReached` loudly (a migrate-to-fresh-Booster signal) rather than silently distorting allocation or bricking transfers. A per-token *retirement/migration* path remains the long-term answer if a v2 ever needs an unbounded universe. Regression test: `test_H2_knownTokenCap_enforced`. **Note:** the cap makes the forced transfer-path loop bounded but not free (worst case ~128 SLOADs/SSTOREs); acceptable on this Orbit L2. A future redesign that iterates only the current basket would remove the cost entirely.

---

## MEDIUM

### M-1 — `FeeSplitter.flush()` couples all three payouts; `setSinks` unguarded
**src/FeeSplitter.sol:39,62** — `flush()` does three `_send`s and `_send` reverts on failure, so one reverting recipient blocks the whole distribution. Today all three sinks are safe receivers (Booster `receive(){}`, dev-wallet EOA, BuybackBurner `receive(){}`), so impact is low **now** — but `setSinks` accepts any address with no check, and a later mis-set to a reverting contract would brick distribution. Trading itself stays live (the hook's `flush` is independent), so this is liveness-of-distribution only. **Fix:** make each leg independently recoverable (pull pattern or per-leg try/catch that leaves failed amounts buffered), and validate sinks.

### M-2 — Slippage guard depends on a loosely-stale manual ETH price
**src/Booster.sol:124,295** — With no on-chain ETH/USD feed on RH Chain, `minOut` is derived from `ethUsdManualE8` with a default `manualStaleAfter = 1 days`. A day-stale ETH price makes the Chainlink-derived floor loose, weakening the sandwich guard on `poke` swaps by however far ETH moved. Separately, `allowUnguarded[token]` sets `minOut = 0` (no protection at all). **Fix:** tighten `manualStaleAfter` to minutes and run the refresher bot on that cadence; keep `allowUnguarded` off in production; prefer a crypto ETH feed if one exists.

### M-3 — StrategyRegistry accepts malformed baskets
**src/StrategyRegistry.sol:138** — `_applyStrategy` enforces `sum(weights) == 10000` and equal lengths, but does **not** reject zero-address tokens, duplicate tokens, or per-element zero weights. A duplicate token double-counts in `Booster.poke` (two slices, `accPerShare` bumped twice); a zero-address token makes `poke` revert on the router call (self-inflicted DoS on that epoch). The signer is trusted, so severity is bounded, but on-chain validation is cheap defense-in-depth. **Fix:** reject `token == address(0)`, reject `weight == 0`, and reject duplicates (baskets are ≤ ~25, so an O(n²) dup check is fine).

### M-4 — Fractional reward remainder discarded on claim
**src/Booster.sol:216** — In `claim`, `rewardDebt[tokenId][token]` is advanced to the full `accPerShare` before the `owed /= SCALE` floor, so the sub-`SCALE` fraction is permanently forfeited each claim. Combined with `poke` rounding (`out*SCALE/totalShares`), the Booster slowly accretes unclaimable dust with no `sweep`. Value is tiny but real and monotonic. **Fix:** carry the remainder (`owed % SCALE`) forward instead of advancing debt past it, and add an owner dust-sweep.

---

## LOW

- **L-1 `CoattailBroker.mint(0)` (src/CoattailBroker.sol:104):** early-returns on `qty == 0` without refunding `msg.value` → attached ETH is stuck. Refund or revert on zero.
- **Resolved follow-up — `mint` reentrancy:** `CoattailBroker.mint` now carries `nonReentrant`; the historical L-2 note is retained here only for review traceability.
- **L-3 `CoatFeeHook.afterSwap` (src/CoatFeeHook.sol:126):** `_recordObservation` calls `stateView.getSlot0`; a revert there would revert the swap, contradicting the "trading is never blockable" invariant. Canonical StateView makes this low, but consider wrapping the observation in try/catch so the fee/TWAP path can never brick a swap.
- **L-4 latent burn/deactivate gap (src/CoattailBroker.sol:157):** `_update` skips deactivation when `to == address(0)`. No burn function exists today, so unreachable — but if a burn is ever added, a burned active Broker would keep its Booster share. Guard now.
- **L-5 renderer reveal ordering (src/BrokerRenderer.sol:103):** `tokenURI` reverts for un-uploaded tokens. Only wire `setRenderer` after **all** 1,776 are uploaded (already in the DEPLOY checklist) or marketplace metadata breaks for the gaps.
- **L-6 zero-address setters:** `FeeSplitter.setSinks`, `Booster` feed/router setters, etc. accept `address(0)`. Add checks.

---

## INFORMATIONAL / ACCEPTED

- **I-1 Single-key admin (accepted by owner).** One hardware wallet holds mutable owner/admin roles; deployer, keeper and oracle keys are separate. A compromise can redirect mutable sinks or configuration, so the key must never enter frontend/keeper infrastructure. The LP NFT is not exposed to this key: it is minted directly to the ownerless permanent locker.
- **I-2 Trusted oracle.** `oracleSigner` unilaterally sets the basket (drift-capped). Disclosed in WHITEPAPER §6; decentralization is a roadmap item, not a launch blocker.
- **I-3 resolved.** Booster now calls the in-repo per-token two-hop StockRouter. H-3 was a fork-emulation mismatch, not an authorization requirement; the corrected live-pool probe passes.

---

## Verdict

No theft-class bug was found in the core value flow. All listed HIGH and MEDIUM findings are fixed and regression-tested. Accepted informational risks remain, especially the hardware-wallet admin and trusted oracle. Current release blockers and current test counts live only in `STATUS.md`; a paid third-party audit remains advisable.

## Current staging qualification

The active chain-46630 deployment is a frontend/renderer staging release, not evidence of stock
distribution: its `StrategyRegistry` remains empty and no Broker has a claimable stock balance.
The pre-mainnet testnet keeper purchase and claim cycle is tracked only in `STATUS.md`.

### Fix log
- **2026-08-15 — mainnet-readiness adversarial pass.** Added `AtomicV4Launcher` and an initializer-gated `0x2044` hook so hook deployment, pool initialization, LP token-ID binding and permanent-locker mint are atomic. Enforced the protected-block buy ceiling against aggregate v4 swap output (not fragmentable `take` transfers). Reworked the hook oracle to update its live cumulative on every swap while rate-limiting only historical checkpoints. Buyback and Booster now process unsolicited ETH in bounded, resumable batches; buyback uses a fee-aware 3% gross-spot gate plus a 5% net execution floor. StockRouter accounts the recipient's actual balance delta, and hook flush events report only successfully sent ETH. Deployment probes immutable registry/WETH dependencies and cross-contract launch linkage. Regression tests cover the previously exploitable TWAP reversal, fragmented launch settlement and oversized-buffer liveness cases; the atomic single-sided launch passed against real mainnet v4.
- **2026-08-14 — H-1, H-2 fixed.** `Booster.poke` empty-basket guard + spend-only wrapping; `Booster.sweepWeth` + `IWETH.withdraw/balanceOf`; `MAX_KNOWN_TOKENS = 128` cap in `_trackToken` with `TokenCapReached`. `MockWETH.withdraw` added. 5 new regression tests.
- **2026-08-14 — fund-safety end-to-end suite (`test/FundSafety.t.sol`, 11 tests).** Explicit proofs of the two invariants that matter: **not stolen** (a stranger cannot execute a Broker's ERC-6551 wallet, cannot claim its rewards, cannot activate it, cannot drive Booster shares; a seller loses wallet control and the buyer gains it) and **not locked** (claimed stock and ETH withdraw fully out of the wallet; a token dropped from the basket stays claimable; active Brokers stay transferable; mint overpayment is refunded; the Booster stays solvent across many claimers, leaving only rounding dust).
- **2026-08-14 — M-1..M-4 fixed.**
  - **M-1** `FeeSplitter`: `flush` now pays each leg independently and *parks* a failing leg in `owed[recipient]` (excluded from future splits via `totalOwed`), so one broken sink can never block the other two or distort the ratio; permissionless `release(to)` retries a parked leg; constructor + `setSinks` reject zero addresses.
  - **M-2** `Booster`: manual ETH/USD staleness default tightened `1 days → 30 minutes` so the sandwich guard can't run on a day-stale price.
  - **M-3** `StrategyRegistry`: baskets now reject zero-address tokens, zero weights, and duplicates on-chain.
  - **M-4** `Booster`: `claim` carries the sub-`SCALE` remainder forward instead of discarding it; added `totalBought/totalClaimed` accounting and a safe `sweepToken(token,to)` that can only recover balance in excess of outstanding entitlement (never owed rewards).
  - New regression tests across `FeeSplitter.t.sol` (M-1), `StrategyRegistry.t.sol` (M-3), `Booster.t.sol` (M-2/M-4). **`forge test`: 112 passed, 0 failed.**
- **2026-08-14 — comparison hardening (vs StonkBrokers reference, see Appendix).** `Booster.setMaxSlippageBps` is now capped at a `MAX_SLIPPAGE_CEILING_BPS = 2000` (20%) hard ceiling instead of 100%, so a compromised owner cannot silently zero the sandwich guard for all tokens (the only way to fully drop the floor is the per-token, event-logged `allowUnguarded`). Regression test `test_setMaxSlippage_cappedAtCeiling`. **`forge test`: 112 passed, 0 failed.**

---

## Appendix — Comparison to the StonkBrokers reference (2026-08-14)

Reviewed the live, Hashlock-audited StonkBrokers docs (`stonkbrokers.cash/docs`) — the closest prior art (same chain, same ERC-6551 + fee-funded-stock primitive) — to sanity-check our design against a proven system.

### What our design gets right (validated by the reference)
- **ERC-6551 TBA-per-NFT vault**, stock held inside, travels with the NFT — identical model.
- **Pull-based, permissionless distribution** (their "Directed Clock In v2" ⇄ our `Booster.poke`/`claim`): the pot swaps into the basket in one pass and credits TBAs pro-rata; anyone can trigger it, no bot required. Same architecture.
- **Activation-gated earning that clears on transfer** — same rule.
- **Feed-guarded stock swaps with `uiMultiplier` already baked into the Chainlink price** — the reference confirms "USD feeds quote the full token price (share × multiplier)", so our `minOut` correctly does **not** re-apply the multiplier.
- **Funds fail-closed / always withdrawable** — the reference is obsessive about this ("settles, rescues, redeems, cash-outs always work"); our `FundSafety.t.sol` proves the same for our system.
- **Graduation threshold ≈ 4 units of the pair asset** — their launcher defaults to 4.0; our locked threshold is 4.2 ETH of paired principal.

### Intentional divergences (design choices, not defects)
- **Activation burn:** they burn **50% / protocol 50%**; we burn **100%** (pure sink — more deflationary, and we forgo activation revenue because the creator already earns mint + royalty and the project earns the 10% fee cut).
- **Tiers:** they ship 5 activation tiers (100×–333× multipliers); we ship a single binary active/inactive in v1 (tiers can be added later without changing the accumulator).
- **Election:** they let each broker elect up to 3 tokens; we ship one global Congress basket — that single, legible basket **is** our product differentiation.
- **Ownership:** their engines are ownerless/immutable; we run a single dev-wallet owner (accepted — I-1).

### Current route conclusion
- **✅ Fixed — slippage-guard ceiling.** `setMaxSlippageBps` is hard-capped at 20%; mainnet also forbids `allowUnguarded=true`.
- **✅ Fixed — router mismatch.** Booster uses the in-repo two-hop StockRouter, not a hardcoded `exactInputSingle`. Route installation validates both token pairs and the mainnet fork executes all five manifest Rialto routes.
- **V1 universe boundary.** The five fork-probed routes (AAPL, AMD, AMZN, COIN and CRCL) are the
  deliberate V1 product universe. The 194-token canonical list is discovery input only; extending
  V1 requires the same independent route, liquidity, feed and fork-probe review.
- **ℹ️ Trust-model note.** The reference markets "no key to player funds." In ours, claimed assets live in the owner-less TBAs (safe) and `sweepToken` can only take non-owed excess — so there is no direct theft path — but the owner still influences execution quality (feeds, sinks, slippage within the 20% cap). Under the single-key decision this is the concentrated risk to protect the key against; it is a trust-model property, not a code bug.
