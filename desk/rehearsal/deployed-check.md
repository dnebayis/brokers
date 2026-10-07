# Deployed check: testnet

Run 2026-10-07 11:13 UTC on an anvil fork of chain 46630 at block 130,465,437, against the contracts already deployed there (testnet-46630-v3.json; nothing redeployed).
Nothing was sent to a real network. The keeper's own code made the buys; deployer, keeper and pool
transactions were impersonated on the fork.

| step | check |
|---|---|
| 1 config | PASS engine and deposit router point at each other |
| 1 config | PASS every Desk wallet is bound to this engine |
| 1 config | PASS fee flush floored by Chainlink ETH/USD |
| 1 config | PASS fee 0.5%, deposit cap $1,000 |
| 1 config | PASS traits frozen, mint open |
| 2 mint | PASS 120,000 COAT went to the bonus pool, none burned |
| 2 mint | PASS Desk #1 renders on chain |
| 3 deposit | PASS principal $600 |
| 3 deposit | PASS over the $1,000 cap is refused (room $400.00) |
| 3 deposit | PASS 0.01 ETH arrived as 26.92 USDG and was booked |
| 4 buy | PASS the keeper bought 0.2856 tNVDA, 0.2700 tMSFT, 1.9195 tAAPL into the Desk wallet |
| 4 buy | PASS booked USDG is invested |
| 4 buy | PASS the engine holds only its fees |
| 5 own | PASS the engine refuses to sell more tAAPL than it bought |
| 5 own | PASS the keeper left alice's own tAAPL alone |
| 5 own | PASS principal unchanged |
| 6 prices | PASS managed value $621.91 -> $639.95 (+2.90%); principal $626.92 and room unchanged |
| 7 withdraw | PASS principal down by $57.22, the tMSFT's value |
| 7 withdraw | PASS principal at the cap; 1 more USDG is refused |
| 8 fees | PASS the Booster received 0.001562 ETH (all of the fees), every fill above the Chainlink ETH/USD floor |
| 8 fees | PASS the deposit after the withdrawal is invested |
| 9 sale | PASS alice no longer controls the wallet |
| 9 sale | PASS the engine cannot pull while paused |
| 9 sale | PASS the portfolio stayed in the Desk; the engine holds nothing |
