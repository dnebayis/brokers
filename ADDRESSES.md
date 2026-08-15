# Robinhood Chain addresses

No COAT **mainnet** deployment is recorded yet. The active clean chain-46630 staging deployment is listed below; it is the only address set the frontend may use until mainnet release gates pass.

## Active testnet staging (chain 46630)

Mint is open on this staging release. The complete renderer collection was uploaded in 62 successful transactions; renderer binding and mint opening were both confirmed with `status=1`.

| Component | Address |
|---|---|
| CoattailBroker | `0x1f6e75a3add9c7debc8594d4f41fa557fc33ddaf` |
| COAT | `0xd3f44c7dd32d12c7a6776c23c839deca8196cf07` |
| BrokerAccount implementation | `0xf93cc17536c9f7839a9a23a1e90161ce4111aa26` |
| StrategyRegistry | `0xd859b6ea10dd61604b55e8e86dc4a12c1e1f7ab3` |
| ERC-6551 Registry | `0x000000006551c19487814612e58FE06813775758` |
| Booster | `0x39e4b20401dc4ca45c0b14800c86fc3df953a245` |
| StockRouter | `0xcf6eda70fa9c1293c7c844c3f26af307703c6d67` |
| FeeSplitter | `0xc1250d95ee696c52ddc2636a74edab5cf32107d7` |
| BrokerRenderer | `0x87af3a4333914ee050a4395e8897ba6e87574739` |
| CoatFeeHook | `0xabc22a662a1bf11f6306ba192ce33acef31d2044` |
| Permanent LP Locker | `0x2f02674d9783e6f7baba681aca0880afe9c08511` |
| CoatRouter | `0x5fbca6b6dd403659b273ea7d6d13e6a2e2462123` |
| BuybackBurner | `0xf6afc4614adff1aedb04d0d374ec4d0d3bbe6964` |
| Native ETH/COAT pool ID | `0x09253fb30ff72d19ed011744fd0a12dbc0ed40529c186f621f5801563812124a` |

The testnet `StrategyRegistry` is **epoch 0 with no basket** at this time. The addresses above
do not mean test stock has been bought or claimed: the testnet indexer/keeper cycle remains a
release task in [STATUS.md](STATUS.md). `StrategyRegistry` and the ERC-6551 registry are distinct
contracts; frontend integrations must not substitute one for the other.

## Canonical infrastructure

| Component | Mainnet address |
|---|---|
| ERC-6551 Registry | `0x000000006551c19487814612e58FE06813775758` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| Uniswap v4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| Uniswap v4 Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Uniswap v4 StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| Uniswap v4 V4Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

Mainnet chain ID is `4663`; testnet is `46630`. The public RPCs are `https://rpc.mainnet.chain.robinhood.com` and `https://rpc.testnet.chain.robinhood.com`.

## V1 route-ready production universe

The complete 194-token canonical discovery snapshot lives in `indexer/tokens.py`; canonical status
alone never makes a token purchasable. V1 intentionally uses only the five entries below, recorded
in `indexer/route-ready.mainnet.json`. Each passed a live fork probe. Other canonical assets are
outside V1 until they independently pass the same checks.

| Ticker | Canonical token | Stock pool | Guard feed |
|---|---|---|---|
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | `0x957BB4b86CCC706D44983fb889ED63c6F9Bdc662` | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` |
| AMD | `0x86923f96303D656E4aa86D9d42D1e57ad2023fdC` | `0xaF7e236Fd675a4dE1A393516105dB8AFb53DC1EB` | `0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72` |
| AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | `0x3785715B43Ed03Da120f4aE7B23bB1274d5E02Dd` | `0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C` |
| COIN | `0x6330D8C3178a418788dF01a47479c0ce7CCF450b` | `0x33918df3a039312217524491f60e9e69000c30c9` | `0xA3a468A452940B7D6b69991207B508c609a98Ef2` |
| CRCL | `0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5` | `0x2099FEde2Ae9C852c753280b6011E6D622868C08` | `0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a` |

The shared WETH/USDG mid pool is `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca`. Rialto is the liquidity venue, not the issuer or owner of the canonical stock tokens.

## Deployment recording rule

After a clean testnet or mainnet deployment, store the generated manifest, parameter hash, chain ID, deployment block and bytecode checks. Never copy addresses manually into the frontend before the manifest passes the wiring checks. Remaining deployment work is listed only in [STATUS.md](STATUS.md).
