# The Desk: local testnet rehearsal (build order step 5, dress run)

Run 2026-09-27 19:42 UTC on an anvil fork of Robinhood Chain testnet (46630) at block 125,331,093.
Nothing was sent to the real testnet. Deployer transactions were impersonated on the fork;
alice and bob were fresh throwaway wallets. Re-run: `cd desk && python3 script/rehearse_local.py`.

Test venue (testnet has no USDG and no v3 USDG pools): test USDG, tMSFT, and oracle-priced
pools filling at feed price minus 0.30%. The tAAPL staging feed was refreshed to $200, tMSFT
feed $500, ETH feed $2,700. The Desk uses its own strategy slot; Booster slot 0 untouched.

Desk #1, bonus Brokers [457, 462].

## Checks

- step 1 deploy: PASS traits uploaded and frozen against the commit
- step 1 deploy: PASS desk mint open
- step 1 deploy: PASS engine at pilot parameters (0.5% fee, $1,000 cap)
- step 1 deploy: PASS desk strategy slot 1 holds tAAPL 100% (epoch 1); Booster slot 0 untouched
- step 2 brokers: PASS Brokers [457, 462] active in the Booster
- step 3 mint: PASS Desk #1 owned by alice
- step 3 mint: PASS Desk wallet deployed at mint (0x0B5328980d5A610909A6E9B61357982Fb43Bd49B)
- step 3 mint: PASS 120,000 COAT went to the bonus pool, none burned
- step 3 mint: PASS tokenURI renders on chain
- step 4 deposit: PASS Desk wallet holds 1,200 USDG
- step 5 buy: PASS clipped to the $1,000 pilot cap (gross)
- step 5 buy: PASS the 200 USDG over the cap stays in the Desk
- step 5 buy: PASS tAAPL fill above the Chainlink floor (9970 bps of oracle)
- step 5 buy: PASS 0.5% fee (5 USDG) held by the engine
- step 5 buy: PASS a second buy reverts: cap used up
- step 6 rebalance: PASS the 200 idle USDG was not touched
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
- rebalance cost (USD): 4.73 of 1192.01 (0.40%)
- rebalance engine fees (USD): 2.96

## Transactions

| step | what | gas |
|---|---|---|
| 1 deploy | 34 deployer transactions | 20,687,845 |
| setup | deployer sends alice COAT for a desk mint and two broker activations | 54,155 |
| setup | alice gets 1,500 test USDG | 53,555 |
| 2 brokers | alice mints 2 Brokers | 395,003 |
| 2 brokers | approve activation burn | 46,414 |
| 2 brokers | activate Broker #457 | 138,458 |
| 2 brokers | activate Broker #462 | 133,658 |
| 3 mint | approve mint price | 46,402 |
| 3 mint | alice mints a Desk | 209,028 |
| 4 deposit | alice deposits 1,200 USDG | 51,556 |
| 5 buy | keeper buyBasket | 247,614 |
| 6 rebalance | new basket posted (epoch +1) | 89,843 |
| 6 rebalance | keeper sells 30% of the tAAPL | 168,319 |
| 6 rebalance | keeper buyStock tMSFT with the proceeds | 182,768 |
| 7 fee split | keeper flushFees | 190,820 |
| 8 bonus | poster posts round 0 | 120,589 |
| 8 bonus | bob claims for Broker #457 (permissionless) | 108,576 |
| 8 bonus | alice claims for Broker #462 | 83,601 |
| 9 withdraw | alice pulls tMSFT out | 65,828 |
| 9 withdraw | alice pulls leftover USDG out | 48,680 |
| 10 sale | bob pays alice 0.01 ETH (off-market sale stand-in) | 21,000 |
| 10 sale | alice transfers Desk #1 to bob | 55,101 |
| 10 sale | bob pauses the engine on his Desk | 58,714 |
| 10 sale | (test) 50 USDG lands in the Desk | 53,567 |
| 10 sale | bob withdraws the tAAPL he bought with the Desk | 65,828 |

## Addresses (fork only, not deployed anywhere)

- aaplPool: `0xa96F3bbaE09f40a8D04642149D1bc077c0282aBc`
- accountImpl: `0x5f07D2007cA2A5c4BE523E283970AeD3cd78F1D5`
- bonus: `0x22a073237a400C40A26EF945C066aB4d8e06F118`
- booster: `0xE683Db9bbb74a6296Cd24F4e1B8E540C19d6BeA7`
- brokers: `0x2Dc7BAD968061bBb5B19066F3769EC90271e09C7`
- chainId: `46630`
- coat: `0x1fa24Ce38f1B956ADfe1ffF87d2f1d234844203E`
- deployer: `0x9e643731dc9D8795573Aa34C410664407FfDC440`
- desks: `0xCD0cA9D85bDE3d474B1d714d364CFf7fb8A31499`
- engine: `0x14D1E5d146d382b101F35fb275991672920002cf`
- ethFeed: `0xefedEd74D1D7C7936346c4C0201c3F3C2893a534`
- ethPool: `0x053828003B4FCAF1e35376c00F53728Cf57166a0`
- msftFeed: `0xB26F11DEc70fa59F81d66e4dCE0dD81ACD71676D`
- msftPool: `0x5090c65Fc1fACdb439984F39daFFf87F3c6B0BF8`
- registry: `0x90252Ef04cC9b40d3E684edff9b7ae213e454e6A`
- renderer: `0x9E273623d6ceBD56AF7eE72BfA9646C511ea648f`
- strategyId: `1`
- taapl: `0xd70A1Cc63a99Aa0bD8C27c7bd43f46d6700586aE`
- taaplFeed: `0x9A1e65F136f69980BEf2Acb307e16b79E1EF5CE4`
- tmsft: `0xa0a9965A6fD63751E1f854f7beCA37cd5745Da39`
- treasury: `0x7b64700155969Df0B96d61342b638CF6e4B45d51`
- usdg: `0x89E6f571f77ABfC9B53331cb5E48d6bb343A3f65`
- weth: `0x7943e237c7F95DA44E0301572D358911207852Fa`
