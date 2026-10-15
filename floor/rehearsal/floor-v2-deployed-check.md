# The Floor v2, rehearsed on a mainnet fork

_2026-10-15 16:12 UTC, anvil fork of Robinhood Chain 4663 at block 89357559;
`script/rehearse_v2.sh`: `DeployMainnetFloorV2.s.sol` broadcast onto the fork as the deployer,
then `test/ForkFloorV2.t.sol` against the router it deployed. Nothing was sent to a real network._

Router: `0xb0614880C99a24ebE97379237D8044130c873B4a` (the real deployment, driven on the fork).

| test | result |
|---|---|
| test_config_asDeployed() | PASS |
| test_congressLive_coat() | PASS |
| test_congressLive_eth_everyNameLands() | PASS |
| test_congressLive_usdg() | PASS |
| test_flush_allToTheBooster() | PASS |
| test_nameWithoutPool_skippedOnBuy_handedBackOnSell() | PASS |
| test_playbooks_runOnV2_forARealBroker() | PASS |
| test_sellBasket_toUsdgAndCoat() | PASS |

    Suite result: ok. 8 passed; 0 failed; 0 skipped; finished in 19.12s (120.09s CPU time)
