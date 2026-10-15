# The Floor: where it stands

_Updated 2026-10-15._

## Current state

**v2 is live:** `0xb0614880C99a24ebE97379237D8044130c873B4a` (deployed by the deployer
2026-10-15, block 89355052, 26 routes; record `rehearsal/floor-v2-mainnet.json`).

| Step | State |
|---|---|
| on-chain settings read back | fee 30 bps, 100% to the Booster, keeper relay, 96h stock / 30h ETH windows, Chips preset, `basketLegs(0)` = the six epoch-59 names, none skipped |
| the deployed router driven on a mainnet fork (`FLOOR_V2=... script/rehearse_v2.sh`) | 8/8, `rehearsal/floor-v2-deployed-check.md` |
| source verification | Sourcify exact match; Blockscout's API was behind a Cloudflare challenge at deploy time, retried |
| site | `frontend/src/lib/floor.ts` router = v2 |
| keeper fee flush | `FLOOR_ROUTER` secret = v2 |
| v1.3 fees | flushed by the deployer (v1 holds 0 USDG) |
| Playbooks | **cancelled** (founder, 2026-10-15): keeper stage off, panel off the site, on-chain keeper set to address(0) (tx `0x08ee387b…aed93`); see `playbooks/STATUS.md`. The engine still points at v1.3 |
| DefiLlama adapter | lists the v1 address; add v2 on the next update of PR DefiLlama/DefiLlama-Adapters#20930 |

v1.3 (`0x478F22A32663cF37702d65352A7579A73e61FDc7`) stays deployed: its seven names still trade
there for anyone calling it directly, but its Congress Live buy reverts since epoch 59.

## What v2 changes

| | v1.3 (live) | v2 |
|---|---|---|
| a preset name without a pool | the whole buy reverts | skipped, its weight spread over the rest (as DeskEngine) |
| `sellBasket` leg without a pool | the whole sell reverts | handed to `recipient` unchanged, no fee |
| routes at deploy | 7 | all 26 v3 names of `indexer/route-ready.mainnet.json` |
| swap core | partial fills leave input in the router | exact-in, one exact callback payment, output measured on the recipient (DeskEngine audit fixes 2 and 3) |
| ETH legs (ETH and COAT in, ETH and COAT out, flush) | no oracle floor | Chainlink ETH/USD floor (the Booster's feed, 30h window) |
| `setPool` | any USDG pool | needs a Booster feed for the stock; `address(0)` removes a route |
| curated presets | any names | routed names only |
| fee split | set to 100% Booster by an owner tx | 100% Booster by default; a zero share sends nothing |
| new view | | `basketLegs(id)`: what a buy actually buys, and what it skips |

Everything else (fee 30 bps, 5% Chainlink band, 96h stock-feed window, keeper relay, Chips
preset, function signatures the site and Playbooks call) is unchanged.

## Checks

| What | Result |
|---|---|
| unit, fuzz (`forge test --no-match-contract Fork`) | 37/37 (17 from v1, 20 new) |
| dry run of `script/DeployMainnetFloorV2.s.sol` on mainnet | 26 routes wired, about 0.00037 ETH |
| `script/rehearse_v2.sh` (the script broadcast on a mainnet fork, then `test/ForkFloorV2.t.sol`) | 8/8: config, live basket in USDG/ETH/COAT, a name without a pool skipped on the buy and handed back on the sell, Playbooks moved onto v2 and run for Broker #1422, flush to the Booster. Report: `rehearsal/floor-v2-rehearsal.md` |
