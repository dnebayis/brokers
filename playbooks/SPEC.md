# Playbooks — Spec v1 (locked and shipped 2026-08-28)

> **Live on mainnet:** `PlaybookEngine` at `0x3b39C832a906E7fE5292F6872c3D3f9eE8340438`
> (chain 4663, source-verified). The panel is in My Brokers on `coattail.cash`; the hourly
> keeper runs installed playbooks. Testnet engine: `0xb9d25e5D211C3AD08647F8826F33906F6b8D2463`
> (chain 46630), where the full path was exercised end to end before launch.

**One line:** your Broker doesn't just get paid, it follows your orders. The owner installs
a "playbook" on a Broker; the keeper executes it every hour.

## Locked decisions

1. **v1 modules** (one contract, `PlaybookEngine`):
   - **Sweep** — move the Broker wallet's claimed stocks to an owner-chosen address each round.
   - **Convert** — sell those stocks through The Floor (`sellBasket`) into USDG, delivered to
     the owner-chosen destination (or left inside the Broker wallet as stablecoin).
   - Auto-claim runs underneath both, but is **not offered as a plan of its own**: the keeper's
     claim distributor already claims for every Broker each hour, so selling that as a feature
     would be dishonest. What needs a decision is where the earnings go afterwards.
   - **Convert to $COAT** — the same sale, then a buy-back through the hooked pool. That leg
     has no Chainlink floor of its own, so the keeper prices the order itself
     (`_coat_min_out`: Chainlink stock floors → fee → ETH at the Booster's price → CoatRouter
     spot → 2% pool cut → 1% drift) and passes that minimum. An order it cannot price is
     skipped, never sent unguarded.
2. **Fees: none added.** Conversions route through The Floor, whose 0.3% already streams
   80% to Broker payroll. Playbooks is a volume feeder, not a new toll booth.
3. **Authority model:**
   - `setPlaybook(tokenId, cfg)` only by the CURRENT NFT owner; the config records who
     set it and self-invalidates when the token changes hands.
   - Convert/Sweep additionally need a one-time max approval per stock token, signed by
     the owner as a TBA `execute(approve(engine))` (BrokerAccount is single-CALL by
     design, so one tx per stock, once ever).
   - Owner can pause or clear a playbook at any time; approvals are revocable the same way.
   - COAT exits are min-out protected with keeper-computed quotes (the hooked pool has no
     Chainlink floor of its own).

## Non-dilution Q&A (required)

- *NFT devalue/bypass?* No. Playbooks run ONLY on active Brokers; there is no NFT-less
  path, and automation utility makes activation strictly more attractive.
- *COAT devalue/bypass?* No new token, no change to burn channels; the Convert→COAT
  module creates programmatic COAT buy pressure through the hooked pool, and Floor fees
  from every conversion feed payroll.

## Keeper flow (hourly, appended to the existing run)

```
for id in enrolled:
  cfg = playbookOf(id); skip if paused or setter != ownerOf(id)
  if cfg.autoClaim: booster.claimFor(id)            # permissionless, no allowance
  if cfg.mode != NONE:
    pull TBA stock balances (allowance-gated), sellBasket via The Floor,
    deliver USDG/COAT/raw stocks to cfg.dest (keeper passes minOut for COAT)
```

**Economics gate (added after measuring):** one playbook run costs ~1M gas (~$0.15 at
current prices) while a Broker earns cents an hour, so running every order hourly would burn
more gas than the salaries are worth. The keeper therefore only executes an order once the
Broker's wallet is worth at least `PLAYBOOKS_MIN_USDG` (default 5 USDG, Chainlink-floored).
Claiming is untouched: it stays hourly and free for every Broker, so nothing about earning
slows down — only the sweep/convert step waits until it is worth doing.

Rollout, all complete: unit tests (8/8) → testnet end-to-end on-chain (real mint, real
36,750 COAT activation, TBA approval via `execute`, sweep + convert + pause verified) →
"Playbooks" panel in My Brokers → mainnet deploy and keeper stage armed.

Open item for v1.1: the keeper skips `TO_COAT` orders because the hooked pool has no
Chainlink floor and an unguarded exit is unacceptable; quoted minimum-out computation in the
keeper closes this. Owners can run those orders themselves in the meantime.

## v2 backlog (locked reasons, not wishes)

1. **`sweep(token, to)` — the missing rescue path.** v1 has none. Normal operation never
   leaves a balance in the engine (pull, sell and deliver all happen inside one call), but a
   token sent directly to the engine address is locked forever. v2 must ship an owner-only
   rescue, and it must be written the way The Floor's is: recoverable only above what is
   owed, so a rescue can never touch anything a holder is entitled to.
2. **Per-order isolation inside `run()`.** v1 has no try/catch per order, so one unfillable
   order reverts the whole batch. The keeper works around it with a free `eth_call`
   pre-flight, but the contract should not depend on a careful caller.
3. **Batched selling across Brokers.** Measured: the swap is 61% of a run's ~988k gas.
   Aggregating several Brokers' holdings into one basket sale and distributing pro rata is
   worth roughly 2.5x at scale. Only worth the added complexity, and the shared-failure risk
   it reintroduces, once enrolment makes the saving real.
