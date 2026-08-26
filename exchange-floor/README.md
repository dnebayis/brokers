# The Floor

Public trading terminal for the live Congress basket on Robinhood Chain. One transaction
buys (or exits) the whole basket, paying in $COAT, ETH or USDG. Non-custodial: everything
settles into the caller's wallet inside the same transaction.

**Mainnet (chain 4663):** `BasketRouter` at
[`0x478F22A32663cF37702d65352A7579A73e61FDc7`](https://robinhoodchain.blockscout.com/address/0x478F22A32663cF37702d65352A7579A73e61FDc7)

## How it works

- `buyBasketEth` / `buyBasket` (USDG) / `buyBasketCoat`: one tx, every stock in the live
  registry basket (preset 0) at its live weight. $COAT entries route through the hooked
  v4 pool first, so they feed the fee flywheel twice.
- `sellBasket`: one tx whole-position (or partial) exit into USDG, ETH or $COAT. A zero
  amount is the "full live balance" sentinel per leg.
- Every stock leg is priced against Chainlink (via the Booster's feeds) with a hard
  on-chain minimum: pools cannot quote a fill below the floor.
- Fee: 30bps (hard cap 100bps). `flushFees` converts accrued USDG to native ETH and
  streams 80% into the Booster payroll, 20% to treasury. Run hourly by the keeper.

## Layout

- `src/BasketRouter.sol` — the venue (plus testnet helpers under `src/testnet/`)
- `test/BasketRouter.t.sol` — 16 unit tests (mock pools, exact fee math)
- `test/ForkBasketRouter.t.sol` — fork tests vs the real mainnet pools
- `test/ForkDeployedFloor.t.sol` — post-launch suite vs the DEPLOYED router, including
  the frontend's exact slippage math replayed on-chain
- `script/` — deploy scripts (testnet iterations + the mainnet deploy)

Run fork suites with:

```bash
forge test --match-path 'test/Fork*' --fork-url https://rpc.mainnet.chain.robinhood.com
```

Libraries resolve from `../contracts/lib` (same pins as the core protocol).
