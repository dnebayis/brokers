# The Desk: local testnet rehearsal (build order step 5, dress run)

Run 2026-10-07 11:12 UTC on an anvil fork of Robinhood Chain testnet (46630) at block 130,464,922.
Nothing was sent to the real testnet. Deployer transactions were impersonated on the fork;
alice and bob were fresh throwaway wallets. Re-run: `cd desk && python3 script/rehearse_local.py`.

Test venue (testnet has no USDG and no v3 USDG pools): test USDG, tMSFT, and oracle-priced
pools filling at feed price minus 0.30%. The tAAPL staging feed was refreshed to $200, tMSFT
feed $500, ETH feed $2,700. The Desk uses its own strategy slot; Booster slot 0 untouched.

Desk #1, bonus Brokers [66, 223].

## Checks

- step 1 deploy: PASS traits uploaded and frozen against the commit
- step 1 deploy: PASS desk mint open
- step 1 deploy: PASS engine at launch parameters (0.5% fee, no deposit cap, 2,000 Desks)
- step 1 deploy: PASS desk strategy slot 2 holds tAAPL 100% (epoch 1); Booster slot 0 untouched
- step 2 brokers: PASS Brokers [66, 223] active in the Booster
- step 3 mint: PASS Desk #1 owned by alice
- step 3 mint: PASS Desk wallet deployed at mint (0xf4d02c0Ea7b3cf056aA668167Fc9361DCD2aE6Eb)
- step 3 mint: PASS 120,000 COAT went to the bonus pool, none burned
- step 3 mint: PASS tokenURI renders on chain
- step 4 deposit: PASS 0.01 ETH arrived as 26.92 USDG (Chainlink floor 26.19)
- step 4 deposit: PASS 10,000 COAT arrived as 0.2650 USDG (thin testnet COAT pool)
- step 4 deposit: PASS principal $927.18 booked, no cap on what more can go in
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
- step 7 fee split: PASS Booster got 0.002725 ETH (100%), treasury 0.000000 ETH
- step 7 fee split: PASS engine keeps no USDG or WETH
- step 8 bonus: PASS each Broker wallet got 60,000 COAT (paid to the NFT, not the caller)
- step 8 bonus: PASS round fully paid, pool empty
- step 8 bonus: PASS double claim reverts
- step 9 withdraw: PASS withdrawals lowered the principal from $927.18 to $655.64, by what left
- step 9 withdraw: PASS 0.5431 tMSFT now in alice's wallet
- step 9 withdraw: PASS a stranger cannot move Desk assets
- step 10 sale: PASS bob owns the Desk
- step 10 sale: PASS 2.8388 tAAPL stayed in the Desk wallet
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
| 1 deploy | 44 deployer transactions | 25,787,619 |
| setup | deployer sends alice COAT for a desk mint and two broker activations | 54,155 |
| setup | alice gets 1,500 test USDG | 53,555 |
| 2 brokers | alice mints 2 Brokers | 395,003 |
| 2 brokers | approve activation burn | 46,414 |
| 2 brokers | activate Broker #66 | 138,446 |
| 2 brokers | activate Broker #223 | 133,646 |
| 3 mint | approve mint price | 46,402 |
| 3 mint | alice mints a Desk | 213,828 |
| 4 deposit | approve USDG deposit | 46,331 |
| 4 deposit | alice deposits 900 USDG | 131,539 |
| 4 deposit | alice deposits 0.01 ETH through the deposit router | 183,064 |
| 4 deposit | approve COAT deposit | 46,414 |
| 4 deposit | alice deposits 10,000 COAT (COAT -> ETH on the live testnet v4 pool -> USDG) | 451,036 |
| 4 deposit | alice sends 200 USDG straight to the wallet, around the router | 34,456 |
| 5 buy | keeper buyBasket | 271,331 |
| 6 rebalance | new basket posted (epoch +1) | 89,843 |
| 6 rebalance | keeper sells 30% of the tAAPL | 206,154 |
| 6 rebalance | keeper buyStock tMSFT with the proceeds | 232,488 |
| 7 fee split | keeper flushFees | 176,950 |
| 8 bonus | poster posts round 0 | 120,589 |
| 8 bonus | bob claims for Broker #66 (permissionless) | 108,574 |
| 8 bonus | alice claims for Broker #223 | 83,579 |
| 9 withdraw | alice pulls tMSFT out | 65,840 |
| 9 withdraw | alice pulls leftover USDG out | 48,668 |
| 10 sale | bob pays alice 0.01 ETH (off-market sale stand-in) | 21,000 |
| 10 sale | alice transfers Desk #1 to bob | 55,101 |
| 10 sale | bob pauses the engine on his Desk | 58,714 |
| 10 sale | (test) bob gets 50 USDG | 53,567 |
| 10 sale | approve | 46,343 |
| 10 sale | bob deposits 50 USDG into his Desk | 131,641 |
| 10 sale | bob withdraws the tAAPL he bought with the Desk | 65,840 |

## Addresses (fork only, not deployed anywhere)

- aaplPool: `0x0102A8693Ddc7538d2F6aE06f76e308c1A351a4e`
- accountImpl: `0xF98BDa5A0A3e18c5a1260E0695Fa506d9c5BCCE0`
- bonus: `0x4ec5e86e8279fdc8AaC2c9F4F04B4Ac6E3686425`
- booster: `0xE683Db9bbb74a6296Cd24F4e1B8E540C19d6BeA7`
- brokers: `0x2Dc7BAD968061bBb5B19066F3769EC90271e09C7`
- chainId: `46630`
- coat: `0x1fa24Ce38f1B956ADfe1ffF87d2f1d234844203E`
- coatRouter: `0x995A4dd800EF2d99550B81097F82fDa79A43208b`
- deployer: `0x9e643731dc9D8795573Aa34C410664407FfDC440`
- depositRouter: `0x670dC01A3F734Fd89d3B1aB5F3200abC4A8c9539`
- desks: `0xcdF55347cCa2722fe6329b02c9C62408125B4F64`
- engine: `0x82461CD760bA5567C327Ba4b379Ce405057EAe28`
- ethFeed: `0xa404a78bBB583Df4201763b557f904d04f607c9d`
- ethPool: `0xa65e573273754ef294C701A08b2B69A82026e1F2`
- msftFeed: `0x04a9F9129a3A3B74e661a6412aF4432A5fB3dDb1`
- msftPool: `0xda022B4b331Ee89EC75867Cd0f51A57Ab1259529`
- nvdaFeed: `0xd43cE92b8243260eE2068Cc69A7D2218Fd659099`
- nvdaPool: `0xa0aF9926D05d8E3Ad8ccb20eCF76964f3f77B80F`
- registry: `0x90252Ef04cC9b40d3E684edff9b7ae213e454e6A`
- renderer: `0xfF95102fC2d92cf9838bD53C0d5acA14F000F583`
- strategyId: `2`
- taapl: `0xd70A1Cc63a99Aa0bD8C27c7bd43f46d6700586aE`
- taaplFeed: `0x9A1e65F136f69980BEf2Acb307e16b79E1EF5CE4`
- tmsft: `0x1e3C8d4F16AFc60a29d4257124926Af9383d9268`
- tnvda: `0xd5Db94e38E4B200bb914CC7e711866a8ff78C949`
- treasury: `0x8A6f1322d1C53b1133610afEc1c8C4d93F4113C9`
- usdg: `0x1D3fe2F7dC9c33Fe2e006F5338591d4D937c456e`
- weth: `0x7943e237c7F95DA44E0301572D358911207852Fa`
