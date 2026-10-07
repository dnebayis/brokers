# Deployed check: mainnet

Run 2026-10-07 11:03 UTC on an anvil fork of chain 4663 at block 82,421,927, against the mainnet deploy script broadcast onto the fork (the real deploy, rehearsed), then its contracts.
Nothing was sent to a real network. The keeper's own code made the buys; deployer, keeper and pool
transactions were impersonated on the fork.

| step | check |
|---|---|
| 1 config | PASS engine and deposit router point at each other |
| 1 config | PASS every Desk wallet is bound to this engine |
| 1 config | PASS fee flush floored by Chainlink ETH/USD |
| 1 config | PASS pilot cap $1,000, fee 0.5% |
| 1 config | PASS traits frozen, mint open |
| 1 config | PASS 26 names routed; the live basket (epoch 58: INTC, MSFT) is fully buyable |
| 1 config | PASS keeper and bonus poster as configured |
| 2 mint | PASS 120,000 COAT went to the bonus pool, none burned |
| 2 mint | PASS Desk #1 renders on chain |
| 3 cap | PASS principal $600, room $400 |
| 3 cap | PASS a 500 USDG deposit is refused (only $400 of room) |
| 3 cap | PASS 0.01 ETH arrived as 25.80 USDG and was booked |
| 4 buy | PASS the keeper bought 2.7507 INTC, 0.5893 MSFT into the Desk wallet |
| 4 buy | PASS booked USDG is invested |
| 4 buy | PASS the engine holds only its fees |
| 5 own | PASS the engine refuses to sell more INTC than it bought |
| 5 own | PASS the keeper left alice's own INTC alone |
| 5 own | PASS principal unchanged |
| 6 prices | PASS managed value $619.33 against $625.80 put in: fills within 3% of the feeds after the 0.5% fee |
| 7 withdraw | PASS room grew by $154.94, the MSFT's value |
| 7 withdraw | PASS principal at the cap; 1 more USDG is refused |
| 8 fees | PASS the Booster received 0.002238 ETH (all of the fees), every fill above the Chainlink ETH/USD floor |
| 8 fees | PASS the room filled after the withdrawal is invested |
| 9 sale | PASS alice no longer controls the wallet |
| 9 sale | PASS the engine cannot pull while paused |
| 9 sale | PASS the portfolio stayed in the Desk; the engine holds nothing |
