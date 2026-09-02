# Coattail Brokers — Fee-Split & Flywheel Model (v1)

> **Live routing note (owner ops, reversible):** the 80/10/10 ratios below are constants, but every slice's
> destination is a settable sink. As of the FeeSplitter `setSinks` and Floor `setSplit` transactions
> (blocks 52,952,305 and 52,952,360), all three FeeSplitter sinks and 100% of the Floor fee point at the
> Booster: every fee the protocol takes buys stock for holders. The scenario tables below keep the
> original split for the record.

Purpose: pressure-test the **80 / 10 / 10** split (Booster / project treasury / buyback) against realistic volume, and decide whether the numbers hold. All figures illustrative; **assumption: ETH = $3,000**. Written pre-launch and kept as the reasoning record — §5 documents the two fee sources added after launch, and the buyback slice was later re-pointed to the Booster by holder vote (effective 90/10).

---

## 1. Where revenue actually comes from

The FeeSplitter is funded by sell-side ETH fees from the `$COAT` hook. Mint and
royalty revenue are deliberately outside it:

| Source | Fee rate | Volume needed for ~10 ETH/mo | Realistic driver? |
|---|---|---|---|
| **$COAT swap fees (`CoatFeeHook`)** | immutable 1% | ~1,000 ETH/mo of $COAT volume | **Yes — this is the real engine** |
| Mint proceeds | 0.001 ETH × 1,776 | one-time = 1.776 ETH | → **creator** (not the flywheel) |
| NFT secondary royalty | 2.5% ERC-2981 | marketplace-dependent | → **creator** (not the flywheel) |

**Key insight:** the flywheel is powered mainly by **$COAT trading volume via the `CoatFeeHook`** (a real Uniswap v4 `afterSwap` hook — see below), not NFT royalties. The activation model *reinforces* this: every mint-to-activate and every re-activation after a resale is a **forced buy-and-burn of $COAT through the pool**, generating hook swap fees *and* shrinking supply. So $COAT volume isn't just speculative — it's structurally driven by the collection's own activation demand. Treat $COAT volume as the primary fuel.

### The fee hook (implemented + fork-proven)
`CoatFeeHook` skims an immutable **1%** protocol fee from **every** $COAT/ETH swap, on top of the LP fee:
- **Sells (COAT→ETH):** fee taken in **ETH** → accrues in the hook → `flush()` routes it to the **FeeSplitter** (80/10/10 → Booster buys stock, project treasury, buyback). This is the ETH that fuels per-Broker rewards.
- **Buys (ETH→COAT):** fee taken in **COAT** → `COAT.burn()`; both the holder balance and ERC-20 `totalSupply` decrease.

Because forwarding is separate from the swap callback, a downstream failure cannot
brick trading. `FeeSplitter.flush()` independently pays or parks each leg, so one reverting
recipient cannot block the others. The hourly keeper advances the hook, splitter, Booster and
bounded buyback stages.

**Mint proceeds + royalty → creator.** The 0.001 ETH mint fee goes directly to the `creator` wallet (`CoattailBroker.setCreator`). ERC-2981 reports a fixed 2.5% secondary royalty to the current creator. Permissionlessly collected LP fees go to project treasury, the hook's sell-side ETH follows FeeSplitter 80/10/10, and there is no team/creator/reserve token allocation.

**Staging clarification.** The active testnet StrategyRegistry is at epoch 1 with a deterministic
test basket, and a receipt-checked hook → splitter → Booster purchase delivered its assets into two
Broker TBAs (#487, #742). This exercised the fee path on staging only; it is not a live-product
distribution and does not change the fee model. The full-scale load and a mainnet deployment remain
outstanding (see `STATUS.md`).

---

## 2. Scenarios (monthly protocol revenue → outcomes)

Input = total monthly ETH into FeeSplitter. Outputs split 80/10/10.

| | **Low** | **Base** | **High** |
|---|---|---|---|
| Monthly revenue | 2 ETH ($6k) | 10 ETH ($30k) | 50 ETH ($150k) |
| → Booster (80%) | 1.6 ETH ($4.8k) | 8 ETH ($24k) | 40 ETH ($120k) |
| → Project treasury (10%) | 0.2 ETH ($600) | 1 ETH ($3k) | 5 ETH ($15k) |
| → Buyback (10%) | 0.2 ETH ($600) | 1 ETH ($3k) | 5 ETH ($15k) |
| **Stock reward / Broker / mo** | **$2.70** | **$13.51** | **$67.57** |
| **Stock reward / Broker / yr** | **~$32** | **~$162** | **~$811** |

Per-Broker reward = Booster ÷ **active** Brokers. The table above assumes all 1,776 are active (worst case for per-Broker reward). **Only active Brokers earn**, so the real per-active reward is Booster ÷ `activeShares` — always **≥** the figures above, and materially higher when only a fraction have burned $COAT to activate.

**Reading it:**
- **Low volume is the danger zone.** ~$32/yr/Broker (all active) is barely perceptible. If only 500 Brokers are active, the same Low scenario is about $115/yr per active Broker.
- **Base scenario:** the example annualized flow is illustrative only; a Broker mints for 0.001 ETH and rewards remain volume-funded, variable and not guaranteed.
- **High is a flywheel.** ~$811/yr/Broker (all active) is economically meaningful, but remains variable volume-funded rewards rather than guaranteed yield.

---

## 3. Does 10% project treasury make sense at every level?

Fixed monthly operating cost estimate (oracle bot + RPC/Alchemy + data APIs + minimal dev): **~$800–2,000/mo.**

| Scenario | Project treasury (10%) | Covers ~$1.5k infra? |
|---|---|---|
| Low | $600/mo | ⚠️ No — subsidized by mint proceeds early |
| Base | $3,000/mo | ✅ 2× over |
| High | $15,000/mo | ✅ 10× over |

The split is deliberately and immutably **holder-first: 80% of every fee buys stock.** The 10% project cut funds the project's future (infra, audit, dev). Creator mint proceeds and 2.5% secondary royalties stay outside this flywheel.

---

## 4. Buyback (10%) sanity

Buyback-and-burn pressure on $COAT:
- Low: $600/mo — token cosmetic, not a real floor.
- Base: $3k/mo — modest, steady burn.
- High: $15k/mo — meaningful, especially against a thin single-sided-launch float.

The v1 buyback share is immutably 10%. Each execution is capped at `0.01 ETH` (and may be selected smaller), leaving excess ETH for later permissionless batches so donations or ordinary accumulation cannot freeze buybacks.

**Activation is the primary sink.** The immutable cost is **36,750 COAT per activation**, repeated after every real NFT transfer. Full first activation burns **65.268M COAT (6.5268% of initial supply)**. Integer/Q96 launch modeling estimates the first fee-inclusive purchase near 0.0003756 ETH and the average of all 1,776 first activations near 0.0003993 ETH as price moves.

---

## 5. Second and third fee sources (added post-launch)

This model was written when $COAT swap volume was the only fuel. Two more inflows now reach the
same Booster, both as **native ETH**, both on top of the split above rather than replacing it:

- **The Floor** takes 30 bps on every basket trade. The keeper converts the accrued USDG to ETH
  and sends **80% to the Booster**, 20% to treasury. This income does not depend on $COAT trading
  at all — a stranger who never touches the token still funds Broker payroll by trading the basket.
- **Playbooks** adds no fee. Its conversions route through The Floor, so an owner automating their
  Broker mechanically increases Floor volume, which increases payroll.

Both ceilings are hard-coded (Floor fee ≤1%), both splits are settable levers, and neither path
can pay out to anyone but Brokers and the treasury.

---

## 6. Verdict & actions

1. **80/10/10 (holder-first).** 80% of every fee buys stock; 10% funds the project's future; 10% feeds the permissionless, 30-minute-TWAP guarded buyback and burn. The split is immutable. Creator income is the mint plus the separate 2.5% ERC-2981 royalty.
2. **Treat $COAT swap volume as the primary fuel** — the `CoatFeeHook` routing and $COAT liquidity are the highest-leverage things to get right.
3. **Set expectations honestly:** publish that rewards scale with volume; show the live per-Broker rate rather than an APR.
4. **Supply:** 1B initial fixed supply → effectively 100% single-sided LP at launch; the 8,393 token-wei Q96 rounding remainder is burned. No strategic reserve or team allocation.
5. Re-run this model at launch with the real ETH price, real fee rates, and the chosen v4 fee tier.
