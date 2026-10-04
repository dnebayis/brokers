# Deployed check: testnet-46630-v3.json

Run 2026-10-04 19:57 UTC on an anvil fork of chain 46630 at block 128,870,370, against the contracts
already deployed there (nothing redeployed, nothing sent to the real network). The keeper's own
code made the buys; deployer and keeper transactions were impersonated on the fork.

| step | check |
|---|---|
| 1 config | PASS engine and deposit router point at each other |
| 1 config | PASS every Desk wallet is bound to this engine |
| 1 config | PASS fee flush floored by Chainlink ETH/USD |
| 1 config | PASS pilot cap $1,000, fee 0.5% |
| 1 config | PASS traits frozen, mint open |
| 2 mint | PASS 120,000 COAT went to the bonus pool, none burned |
| 2 mint | PASS Desk #1 renders on chain |
| 3 cap | PASS principal $600, room $400 |
| 3 cap | PASS a 500 USDG deposit is refused (only $400 of room) |
| 3 cap | PASS 0.01 ETH arrived as 26.92 USDG and was booked |
| 4 buy | PASS the keeper bought the basket into the Desk wallet |
| 4 buy | PASS booked USDG is invested |
| 4 buy | PASS the engine holds only its fees |
| 5 own | PASS the engine refuses to sell more tAAPL than it bought |
| 5 own | PASS the keeper left alice's own tAAPL alone |
| 5 own | PASS principal unchanged |
| 6 prices | PASS managed value $621.91 -> $660.47 (+6.20%); principal $626.92 and room unchanged |
| 7 withdraw | PASS room grew by $62.19, the tMSFT's value |
| 7 withdraw | PASS principal at the cap; 1 more USDG is refused |
| 8 fees | PASS Booster received 0.000926 ETH (80%), floor 0.001103 ETH for 100% |
| 9 sale | PASS alice no longer controls the wallet |
| 9 sale | PASS the engine cannot pull while paused |
| 9 sale | PASS the portfolio stayed in the Desk; the engine holds nothing |
