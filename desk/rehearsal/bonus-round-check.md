# Bonus rounds, rehearsed on a mainnet fork

_2026-10-09 09:28 UTC, anvil fork of Robinhood Chain 4663 at block 84,044,699; `script/check_bonus_round.py`. Nothing was sent to a real network._

Pool `0xe3c699837b9322cF003A6e7385895f2Fcdde3Ee1`, Brokers `0x1122dB21998707F8c2eD8182734356C947fA5e98`, Booster `0x7bAf435847A4b45c2e22a7fd13549C3192C95953`.

| step | check |
|---|---|
| 1 mint | PASS pool holds 360,000 COAT, all of it unallocated |
| 1 mint | PASS no round yet |
| 2 snapshot | PASS 1,291 active Brokers, one leaf each |
| 2 snapshot | PASS 359999.999999999999999363 COAT = 278.853601859024012393 x 1,291; 0.000000000000000637 stays |
| 2 snapshot | PASS every leaf is an active Broker at the snapshot block |
| 2 snapshot | PASS every leaf names the Broker's own 6551 wallet |
| 3 verify | PASS root, proofs, total and pool balance check out locally |
| 4 post | PASS round 0 posted with the file's root and total |
| 4 post | PASS outstanding = the round, unallocated = the remainder |
| 4 post | PASS posting the same file again sends nothing |
| 4 post | PASS a non-poster cannot post |
| 5 verify | PASS a leaf with a changed amount is refused before anything is sent |
| 6 claim | PASS all 1,291 active Broker wallets gained exactly 278.853601859024012393 COAT |
| 6 claim | PASS inactive Broker #3 got nothing |
| 6 claim | PASS round fully claimed; only the remainder is left in the pool |
| 6 claim | PASS a double claim reverts |
| 6 claim | PASS a claim for a Broker outside the tree reverts |
| 6 claim | PASS 22 batches; a second claim run sends nothing |
| 7 round 2 | PASS round 1 posted next to round 0 |
| 7 round 2 | PASS round 1 paid the new mint plus round 0's remainder (120000.000000000000000218 COAT) |
| 7 round 2 | PASS both rounds fully claimed |

| number | value |
|---|---|
| mint price (COAT) | 120,000 |
| active Brokers | 1,291 |
| per Broker (COAT) | 278.853601859024012393 |
| proof depth | 11 |
| claim batches | 22 |
| claim gas, all batches | 41,843,046 |
| claim gas per Broker | 32,411 |
| wall time | 656s |

## Transactions (fork)

| what | gas |
|---|---|
| approve 4 mints | 46,402 |
| mint Desk #1 | 218,628 |
| mint Desk #2 | 167,328 |
| mint Desk #3 | 167,328 |
| mint Desk #4 | 162,528 |
