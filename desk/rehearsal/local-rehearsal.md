# The Desk: local testnet rehearsal (build order step 5, dress run)

Run 2026-09-27 20:11 UTC on an anvil fork of Robinhood Chain testnet (46630) at block 125,341,145.
Nothing was sent to the real testnet. Deployer transactions were impersonated on the fork;
alice and bob were fresh throwaway wallets. Re-run: `cd desk && python3 script/rehearse_local.py`.

Test venue (testnet has no USDG and no v3 USDG pools): test USDG, tMSFT, and oracle-priced
pools filling at feed price minus 0.30%. The tAAPL staging feed was refreshed to $200, tMSFT
feed $500, ETH feed $2,700. The Desk uses its own strategy slot; Booster slot 0 untouched.

Desk #1, bonus Brokers [617, 842].

## Checks

- step 1 deploy: PASS traits uploaded and frozen against the commit
- step 1 deploy: PASS desk mint open
- step 1 deploy: PASS engine at pilot parameters (0.5% fee, $1,000 cap)
- step 1 deploy: PASS desk strategy slot 1 holds tAAPL 100% (epoch 1); Booster slot 0 untouched
- step 2 brokers: PASS Brokers [617, 842] active in the Booster
- step 3 mint: PASS Desk #1 owned by alice
- step 3 mint: PASS Desk wallet deployed at mint (0xa018660C8a5CBD132a033a4dBFA80016171B9713)
- step 3 mint: PASS 120,000 COAT went to the bonus pool, none burned
- step 3 mint: PASS tokenURI renders on chain
- step 4 deposit: PASS Desk wallet holds 1,200 USDG
- step 4 deposit: PASS 0.01 ETH arrived as 26.92 USDG (Chainlink floor 26.19)
- step 4 deposit: PASS 10,000 COAT arrived as 0.2650 USDG (thin testnet COAT pool)
- step 4 deposit: PASS deposit router holds nothing afterwards
- step 5 buy: PASS clipped to the $1,000 pilot cap (gross)
- step 5 buy: PASS the 227.18 USDG over the cap stays in the Desk
- step 5 buy: PASS tAAPL fill above the Chainlink floor (9970 bps of oracle)
- step 5 buy: PASS 0.5% fee (5 USDG) held by the engine
- step 5 buy: PASS a second buy reverts: cap used up
- step 6 rebalance: PASS the idle USDG over the cap was not touched
- step 6 rebalance: PASS buyStock refuses a name outside the basket
- step 6 rebalance: PASS stock split 70.3% tAAPL / 29.7% tMSFT
- step 6 rebalance: PASS still inside the pilot cap
- step 7 fee split: PASS 7.96 USDG -> 0.002939 native ETH
- step 7 fee split: PASS Booster got 0.002351 ETH (80%), treasury 0.000588 ETH
- step 7 fee split: PASS engine keeps no USDG or WETH
- step 8 bonus: PASS each Broker wallet got 60,000 COAT (paid to the NFT, not the caller)
- step 8 bonus: PASS round fully paid, pool empty
- step 8 bonus: PASS double claim reverts
- step 9 withdraw: PASS 0.5857 tMSFT now in alice's wallet
- step 9 withdraw: PASS a stranger cannot move Desk assets
- step 10 sale: PASS bob owns the Desk
- step 10 sale: PASS 3.4721 tAAPL stayed in the Desk wallet
- step 10 sale: PASS control moved: bob signs, alice cannot
- step 10 sale: PASS alice can no longer withdraw
- step 10 sale: PASS engine cannot pull while bob has it paused
- step 10 sale: PASS bob holds the Desk's tAAPL
- step 10 sale: PASS tokenURI still renders after the sale

## Numbers

- buy fill vs oracle (bps): 9970
- rebalance cost (USD): 4.73 of 1219.20 (0.39%)
- rebalance engine fees (USD): 2.96

## Transactions

| step | what | gas |
|---|---|---|
| 1 deploy | 43 deployer transactions | 24,242,227 |
| setup | deployer sends alice COAT for a desk mint and two broker activations | 54,155 |
| setup | alice gets 1,500 test USDG | 53,555 |
| 2 brokers | alice mints 2 Brokers | 395,003 |
| 2 brokers | approve activation burn | 46,414 |
| 2 brokers | activate Broker #617 | 138,458 |
| 2 brokers | activate Broker #842 | 133,658 |
| 3 mint | approve mint price | 46,402 |
| 3 mint | alice mints a Desk | 213,828 |
| 4 deposit | alice deposits 1,200 USDG | 51,544 |
| 4 deposit | alice deposits 0.01 ETH through the deposit router | 129,012 |
| 4 deposit | approve COAT deposit | 46,414 |
| 4 deposit | alice deposits 10,000 COAT (COAT -> ETH on the live testnet v4 pool -> USDG) | 395,512 |
| 5 buy | keeper buyBasket | 247,614 |
| 6 rebalance | new basket posted (epoch +1) | 89,843 |
| 6 rebalance | keeper sells 30% of the tAAPL | 168,319 |
| 6 rebalance | keeper buyStock tMSFT with the proceeds | 182,768 |
| 7 fee split | keeper flushFees | 177,140 |
| 8 bonus | poster posts round 0 | 120,577 |
| 8 bonus | bob claims for Broker #617 (permissionless) | 108,576 |
| 8 bonus | alice claims for Broker #842 | 100,701 |
| 9 withdraw | alice pulls tMSFT out | 65,828 |
| 9 withdraw | alice pulls leftover USDG out | 48,692 |
| 10 sale | bob pays alice 0.01 ETH (off-market sale stand-in) | 21,000 |
| 10 sale | alice transfers Desk #1 to bob | 55,101 |
| 10 sale | bob pauses the engine on his Desk | 58,714 |
| 10 sale | (test) 50 USDG lands in the Desk | 53,555 |
| 10 sale | bob withdraws the tAAPL he bought with the Desk | 65,828 |

## Addresses (fork only, not deployed anywhere)

- aaplPool: `0x95886330Acf2eFC2C1ea3D4ead7923AF1470b0Cd`
- accountImpl: `0x43BA9438C63569c8Bf2384201AC0F2ce168191C1`
- bonus: `0x167D41d0EbDe40CaaDE2c8C2961d83c1192c9495`
- booster: `0xE683Db9bbb74a6296Cd24F4e1B8E540C19d6BeA7`
- brokers: `0x2Dc7BAD968061bBb5B19066F3769EC90271e09C7`
- chainId: `46630`
- coat: `0x1fa24Ce38f1B956ADfe1ffF87d2f1d234844203E`
- coatRouter: `0x995A4dd800EF2d99550B81097F82fDa79A43208b`
- deployer: `0x9e643731dc9D8795573Aa34C410664407FfDC440`
- depositRouter: `0x559327DA84237B3e7ef4c3E845cBA802541F5c2C`
- desks: `0x76f679A0fb120991f7b0f86582F7F8ca378841a0`
- engine: `0x21A49B0270582b6795BA30B316d45c12fA000620`
- ethFeed: `0xa96F3bbaE09f40a8D04642149D1bc077c0282aBc`
- ethPool: `0x879a4D70b88B886280D24ccb73b91AEe6Ad9f80D`
- msftFeed: `0xefedEd74D1D7C7936346c4C0201c3F3C2893a534`
- msftPool: `0x720c2F1dC0E0750f602A098089632a29166F3873`
- nvdaFeed: `0x32E7976F0EdBEdA0a2cddECe36bCF3646270E307`
- nvdaPool: `0x740d2b2cCd3F21b716A14b0De82300B06595eb06`
- registry: `0x90252Ef04cC9b40d3E684edff9b7ae213e454e6A`
- renderer: `0x432eEB00B94e38483785f7Ae2110ca75A140c520`
- strategyId: `1`
- taapl: `0xd70A1Cc63a99Aa0bD8C27c7bd43f46d6700586aE`
- taaplFeed: `0x9A1e65F136f69980BEf2Acb307e16b79E1EF5CE4`
- tmsft: `0xB26F11DEc70fa59F81d66e4dCE0dD81ACD71676D`
- tnvda: `0x0519C7fAa3dd333A47c33cC9A334ee876fEEbD70`
- treasury: `0x3C944333b0E728c9d89a57Cb7fC0c160e72F5eE9`
- usdg: `0xa0a9965A6fD63751E1f854f7beCA37cd5745Da39`
- weth: `0x7943e237c7F95DA44E0301572D358911207852Fa`
