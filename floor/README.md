# The Floor

Public trading terminal for the live Congress basket on Robinhood Chain. One transaction
buys (or exits) the whole basket, paying in $COAT, ETH or USDG. Non-custodial: everything
settles into the caller's wallet inside the same transaction.

**Mainnet (chain 4663):** `BasketRouter` v1.3 at
[`0x478F22A32663cF37702d65352A7579A73e61FDc7`](https://robinhoodchain.blockscout.com/address/0x478F22A32663cF37702d65352A7579A73e61FDc7),
live since 2026-08-27, source-verified. The UI is the **Floor** tab on `coattail.cash`.
**v2** (this source) is built and rehearsed, waiting for its broadcast: see [STATUS.md](STATUS.md).

## How it works

- `buyBasketEth` / `buyBasket` (USDG) / `buyBasketCoat`: one tx, every stock in the live
  registry basket (preset 0) at its live weight; a name without a pool here is skipped and its
  weight spread over the rest (`basketLegs(0)` shows what a buy buys). $COAT entries route through the hooked
  v4 pool first, so they feed the fee flywheel twice.
- `sellBasket`: one tx whole-position (or partial) exit into USDG, ETH or $COAT. A zero
  amount is the "full live balance" sentinel per leg; a leg without a pool is handed to the
  recipient unchanged.
- Every stock leg is priced against Chainlink (via the Booster's feeds) with a hard
  on-chain minimum, and every ETH leg against Chainlink ETH/USD: pools cannot fill below the floor.
  Swaps are exact-in; a partial fill reverts.
- Fee: 30bps (hard cap 100bps). `flushFees` converts accrued USDG to native ETH and
  streams 100% into the Booster payroll (treasury share set to 0 by owner op). Run hourly by the keeper.

## Layout

- `src/BasketRouter.sol`, the venue (plus testnet helpers under `src/testnet/`)
- `test/BasketRouter.t.sol`, `test/BasketRouterV2.t.sol`: 37 unit and fuzz tests (mock pools, exact fee math, v2 behaviour)
- `test/ForkBasketRouter.t.sol`, fork tests vs the real mainnet pools
- `test/ForkDeployedFloor.t.sol`: post-launch suite vs the deployed v1.3, including
  the frontend's exact slippage math replayed on-chain
- `test/ForkFloorV2.t.sol` + `script/rehearse_v2.sh`: the v2 deploy broadcast on a mainnet fork and driven
- `script/`, deploy scripts (testnet iterations + the mainnet deploy)

Run fork suites with:

```bash
forge test --match-path 'test/Fork*' --fork-url https://rpc.mainnet.chain.robinhood.com
```

Libraries resolve from `../contracts/lib` (same pins as the core protocol).
