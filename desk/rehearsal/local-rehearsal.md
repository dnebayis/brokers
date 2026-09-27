# The Desk: local testnet rehearsal (build order step 5, dress run)

Run 2026-09-27 21:47 UTC on an anvil fork of Robinhood Chain testnet (46630) at block 125,375,617.
Nothing was sent to the real testnet. Deployer transactions were impersonated on the fork;
alice and bob were fresh throwaway wallets. Re-run: `cd desk && python3 script/rehearse_local.py`.

Test venue (testnet has no USDG and no v3 USDG pools): test USDG, tMSFT, and oracle-priced
pools filling at feed price minus 0.30%. The tAAPL staging feed was refreshed to $200, tMSFT
feed $500, ETH feed $2,700. The Desk uses its own strategy slot; Booster slot 0 untouched.

Desk #1, bonus Brokers [1078, 1091].

## Checks

- step 1 deploy: PASS traits uploaded and frozen against the commit
- step 1 deploy: PASS desk mint open
- step 1 deploy: PASS engine at pilot parameters (0.5% fee, $1,000 cap)
- step 1 deploy: PASS desk strategy slot 2 holds tAAPL 100% (epoch 1); Booster slot 0 untouched
- step 2 brokers: PASS Brokers [1078, 1091] active in the Booster
- step 3 mint: PASS Desk #1 owned by alice
- step 3 mint: PASS Desk wallet deployed at mint (0xEF5a9Ade5548075BD6f9BCf16f38890286731648)
- step 3 mint: PASS 120,000 COAT went to the bonus pool, none burned
- step 3 mint: PASS tokenURI renders on chain
- step 4 deposit: PASS 0.01 ETH arrived as 26.92 USDG (Chainlink floor 26.19)
- step 4 deposit: PASS 10,000 COAT arrived as 0.2650 USDG (thin testnet COAT pool)
- step 4 deposit: PASS principal $927.18 booked, $72.82 of room left under the $1,000 pilot cap
- step 4 deposit: PASS a deposit over the pilot cap reverts
- step 4 deposit: PASS USDG sent around the router is not booked, so it is never invested
- step 4 deposit: PASS deposit router holds nothing afterwards
- step 5 buy: PASS every booked dollar went to work; the 200 sent around the router still sits idle
- step 5 buy: PASS tAAPL fill above the Chainlink floor (9970 bps of oracle)
- step 5 buy: PASS buying does not move the principal
- step 5 buy: PASS nothing booked left to buy with
- step 6 rebalance: PASS the unbooked idle USDG was not touched
- step 6 rebalance: PASS buyStock refuses a name outside the basket
- step 6 rebalance: PASS stock split 70.3% tAAPL / 29.7% tMSFT
- step 6 rebalance: PASS a rebalance never moves the principal
- step 7 fee split: PASS 7.38 USDG -> 0.002725 native ETH
- step 7 fee split: PASS Booster got 0.002180 ETH (80%), treasury 0.000545 ETH
- step 7 fee split: PASS engine keeps no USDG or WETH
- step 8 bonus: PASS each Broker wallet got 60,000 COAT (paid to the NFT, not the caller)
- step 8 bonus: PASS round fully paid, pool empty
- step 8 bonus: PASS double claim reverts
- step 9 withdraw: PASS withdrawals lowered the principal from $927.18 to $655.64, reopening room
- step 9 withdraw: PASS 0.5431 tMSFT now in alice's wallet
- step 9 withdraw: PASS a stranger cannot move Desk assets
- step 10 sale: PASS bob owns the Desk
- step 10 sale: PASS 3.0659 tAAPL stayed in the Desk wallet
- step 10 sale: PASS control moved: bob signs, alice cannot
- step 10 sale: PASS alice can no longer withdraw
- step 10 sale: PASS the deposit is booked
- step 10 sale: PASS engine cannot pull while bob has it paused
- step 10 sale: PASS bob holds the Desk's tAAPL
- step 10 sale: PASS tokenURI still renders after the sale

## Numbers

- buy fill vs oracle (bps): 9970
- rebalance cost (USD): 4.39 of 1119.78 (0.39%)
- rebalance engine fees (USD): 2.74

## Transactions

| step | what | gas |
|---|---|---|
| 1 deploy | 43 deployer transactions | 25,188,407 |
| setup | deployer sends alice COAT for a desk mint and two broker activations | 54,155 |
| setup | alice gets 1,500 test USDG | 53,555 |
| 2 brokers | alice mints 2 Brokers | 395,003 |
| 2 brokers | approve activation burn | 46,414 |
| 2 brokers | activate Broker #1078 | 138,458 |
| 2 brokers | activate Broker #1091 | 133,658 |
| 3 mint | approve mint price | 46,402 |
| 3 mint | alice mints a Desk | 213,828 |
| 4 deposit | approve USDG deposit | 46,331 |
| 4 deposit | alice deposits 900 USDG | 131,444 |
| 4 deposit | alice deposits 0.01 ETH through the deposit router | 163,187 |
| 4 deposit | approve COAT deposit | 46,414 |
| 4 deposit | alice deposits 10,000 COAT (COAT -> ETH on the live testnet v4 pool -> USDG) | 429,588 |
| 4 deposit | alice sends 200 USDG straight to the wallet, around the router | 34,456 |
| 5 buy | keeper buyBasket | 265,100 |
| 6 rebalance | new basket posted (epoch +1) | 89,843 |
| 6 rebalance | keeper sells 30% of the tAAPL | 185,868 |
| 6 rebalance | keeper buyStock tMSFT with the proceeds | 222,722 |
| 7 fee split | keeper flushFees | 177,157 |
| 8 bonus | poster posts round 0 | 120,589 |
| 8 bonus | bob claims for Broker #1078 (permissionless) | 108,586 |
| 8 bonus | alice claims for Broker #1091 | 83,591 |
| 9 withdraw | alice pulls tMSFT out | 65,840 |
| 9 withdraw | alice pulls leftover USDG out | 48,680 |
| 10 sale | bob pays alice 0.01 ETH (off-market sale stand-in) | 21,000 |
| 10 sale | alice transfers Desk #1 to bob | 55,101 |
| 10 sale | bob pauses the engine on his Desk | 58,714 |
| 10 sale | (test) bob gets 50 USDG | 53,567 |
| 10 sale | approve | 46,343 |
| 10 sale | bob deposits 50 USDG into his Desk | 133,283 |
| 10 sale | bob withdraws the tAAPL he bought with the Desk | 65,840 |

## Addresses (fork only, not deployed anywhere)

- aaplPool: `0xF71474cb54268AbB080a9E09B0b47b0FbfD8410d`
- accountImpl: `0xbCA0D0014c2389c7cC852b8297bf63107eBbd78c`
- bonus: `0x490B05945B5F27EAF8b678Ef0ADFcc1678f7792C`
- booster: `0xE683Db9bbb74a6296Cd24F4e1B8E540C19d6BeA7`
- brokers: `0x2Dc7BAD968061bBb5B19066F3769EC90271e09C7`
- chainId: `46630`
- coat: `0x1fa24Ce38f1B956ADfe1ffF87d2f1d234844203E`
- coatRouter: `0x995A4dd800EF2d99550B81097F82fDa79A43208b`
- deployer: `0x9e643731dc9D8795573Aa34C410664407FfDC440`
- depositRouter: `0x5114CaCD2d1b4D31D572e45E7187B3C2ebB60203`
- desks: `0xFB57C693E7C4e06D06e7f8edb470D2Aa7Ae162F2`
- engine: `0xc462195cfc7B054BEC6eA5a5797C74AA02de226a`
- ethFeed: `0x537ceDE15e84badae0485c9e03e9a314bCdd203F`
- ethPool: `0x4053d395d8c1f72280695dc27733b98026d9BBA4`
- msftFeed: `0xd547bCFCd14dBb4e75ae6440e0806fc3367d1157`
- msftPool: `0xfC5f05Cb0cfAA7e5619b1aB8052020F943321bb0`
- nvdaFeed: `0xA8079C24178717c4AFDD0B1064Eb685b14028a45`
- nvdaPool: `0xd65Bf714c14067fDD7404611940c6D8761be2f54`
- registry: `0x90252Ef04cC9b40d3E684edff9b7ae213e454e6A`
- renderer: `0x9A25f370faAB0eb5B2584cc27E9a30429e6BbcCF`
- strategyId: `2`
- taapl: `0xd70A1Cc63a99Aa0bD8C27c7bd43f46d6700586aE`
- taaplFeed: `0x9A1e65F136f69980BEf2Acb307e16b79E1EF5CE4`
- tmsft: `0x3E8E965934255d4c6B104579C5c2BFc8f32e8d2C`
- tnvda: `0xCd18e020B744b8aB351df81166430206D001bCee`
- treasury: `0x56EeB274f0871BB57Ff53eCCE8c6b98FFEFAf1D8`
- usdg: `0xE998Ec8A796a91913FFeCED3495F0444aa827034`
- weth: `0x7943e237c7F95DA44E0301572D358911207852Fa`
