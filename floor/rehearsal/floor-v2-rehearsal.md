# The Floor v2, rehearsed on a mainnet fork

_2026-10-14 13:50 UTC, anvil fork of Robinhood Chain 4663 at block 88415258;
`script/rehearse_v2.sh`: `DeployMainnetFloorV2.s.sol` broadcast onto the fork as the deployer,
then `test/ForkFloorV2.t.sol` against the router it deployed. Nothing was sent to a real network._

Router: `0xf5a7fBF67029Ce55fB2eBda168c41600e2919F99` (deployed on the fork by the script).

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

    Suite result: ok. 8 passed; 0 failed; 0 skipped; finished in 12.14s (70.66s CPU time)
