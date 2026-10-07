# Deployed check: mainnet

Run 2026-10-07 11:16 UTC on an anvil fork of chain 4663 at block 82,429,428, against the mainnet deploy script broadcast onto the fork (the real deploy, rehearsed), then its contracts.
Nothing was sent to a real network. The keeper's own code made the buys; deployer, keeper and pool
transactions were impersonated on the fork.

| step | check |
|---|---|
| 1 config | PASS engine and deposit router point at each other |
| 1 config | PASS every Desk wallet is bound to this engine |
| 1 config | PASS fee flush floored by Chainlink ETH/USD |
| 1 config | PASS fee 0.5%, no deposit cap |
| 1 config | PASS all 2,000 Desks mintable, no waves |
| 1 config | PASS traits frozen, mint open |
| 1 config | PASS 26 names routed; the live basket (epoch 58: INTC, MSFT) is fully buyable |
| 1 config | PASS keeper and bonus poster as configured |
| 2 mint | PASS 120,000 COAT went to the bonus pool, none burned |
| 2 mint | PASS Desk #1 renders on chain |
| 3 deposit | PASS principal $600 |
| 3 deposit | PASS 0.01 ETH arrived as 25.82 USDG and was booked |
| 3 deposit | PASS no cap: $5,625.82 put in and booked |
| 4 buy | PASS the keeper bought 24.7569 INTC, 5.2965 MSFT into the Desk wallet |
| 4 buy | PASS booked USDG is invested (3 keeper ticks, at most $2,500 a tick) |
| 4 buy | PASS the engine holds only its fees |
| 5 own | PASS the engine refuses to sell more INTC than it bought |
| 5 own | PASS the keeper left alice's own INTC alone |
| 5 own | PASS principal unchanged |
| 6 prices | PASS managed value $5,570.17 against $5,625.82 put in: fills within 3% of the feeds after the 0.5% fee |
| 7 withdraw | PASS principal down by $1,392.56, the MSFT's value |
| 8 fees | PASS the Booster received 0.003147 ETH (100% of the fees), every fill above the Chainlink ETH/USD floor |
| 8 fees | PASS the deposit after the withdrawal is invested |
| 9 sale | PASS alice no longer controls the wallet |
| 9 sale | PASS the engine cannot pull while paused |
| 9 sale | PASS the portfolio stayed in the Desk; the engine holds nothing |
