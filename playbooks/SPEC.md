# Playbooks — Spec v1 (locked 2026-08-28)

**One line:** your Broker doesn't just get paid, it follows your orders. The owner installs
a "playbook" on a Broker; the keeper executes it every hour.

## Locked decisions

1. **v1 modules** (one contract, `PlaybookEngine`):
   - **Auto-claim** — keeper calls the Booster's permissionless `claimFor` for enrolled
     Brokers each round. Zero approvals needed.
   - **Sweep** — move the TBA's claimed stocks to an owner-chosen address each round.
   - **Convert** — sell the TBA's claimed stocks through The Floor (`sellBasket`) into
     USDG or $COAT, delivered to the owner-chosen destination.
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

Rollout: unit tests → testnet end-to-end (reusing the funded Floor pools) → frontend
"Playbooks" panel inside My Brokers → mainnet deploy + enrollment UX → announcement.
