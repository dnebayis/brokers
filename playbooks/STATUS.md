# Playbooks: where it stands

_Updated 2026-10-15._

**Cancelled by the founder on 2026-10-15.** No standing order runs any more.

| Layer | State |
|---|---|
| keeper | the Playbooks stage is off: repository variable `PLAYBOOKS_PAUSED=1` blanks `PLAYBOOKS_ENGINE` in `keeper-schedule-mainnet.yml`. The keeper run that had started before the switch was cancelled and a fresh one dispatched (2026-10-15) |
| site | the panel is off the Activate tab (`PLAYBOOKS_ON_SITE = false` in `frontend/src/lib/playbooks.ts`) |
| chain | the engine (`0x3b39C832a906E7fE5292F6872c3D3f9eE8340438`) has 780 enrolments. It has no function that lets the deployer delete them: only each Broker's owner can call `clearPlaybook`. What the deployer can do is take the keeper role away |

## The on-chain shutdown (the deployer signs)

```bash
cast send 0x3b39C832a906E7fE5292F6872c3D3f9eE8340438 'setKeeper(address)' 0x0000000000000000000000000000000000000000 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --interactive
```

`run()` accepts only the keeper or the owner, so with the keeper at address(0) the relay (and
anyone else) is refused with `NotKeeper`; only the deployer could still run an order, by hand.
Rehearsed on a mainnet fork on 2026-10-15: before, the relay's `run([1422])` succeeds; after,
it reverts `NotKeeper()` (`0xf512b278`) for the relay and for any other address. Gas about 25k.

Reversible: the same call with the relay address puts it back. A permanent version would be
`renounceOwnership()` after it, but that also removes `setFloor`/`setKeeper` for good.

## What holders keep

- Earnings stay in the Booster, claimable from the Activate tab as before.
- Enrolments and token approvals to the engine stay on chain. Without a keeper nothing uses them;
  a holder can still clear their own entry (`clearPlaybook`) or revoke the approvals from their
  Broker wallet.

## To bring it back

`setFloor(0xb0614880C99a24ebE97379237D8044130c873B4a)` (the engine still points at the retired
Floor v1.3), `setKeeper(0xa492c8fFa033016144B169501D2e428BeDD518CA)`, `PLAYBOOKS_PAUSED=0`,
`PLAYBOOKS_ON_SITE = true`.
