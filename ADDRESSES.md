# Robinhood Chain addresses

## Mainnet Phase 1 — core infrastructure (chain 4663)

Deployed 2026-08-18, blocks `39460869`–`39461182` (12 txs), via `Deploy.s.sol` with the shared-key
model (`ALLOW_DEPLOYER_OWNER=true`). **Both mint and $COAT trading are intentionally CLOSED** — this
is Phase 1 only; the v4 launch (`LaunchWithHook`) and mint opening are Phase 2. All eight contracts
were verified on-chain (codesize > 0, roles, closed-state) immediately after broadcast.

| Component | Mainnet address |
|---|---|
| CoattailBroker | `0x1122dB21998707F8c2eD8182734356C947fA5e98` |
| COAT | `0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833` |
| StrategyRegistry | `0xA20f9D47E0c41e52a57d65feA9A9322732aF86Aa` |
| Booster | `0x7bAf435847A4b45c2e22a7fd13549C3192C95953` |
| StockRouter | `0x99F3f896B58bcb8A515ED3C7174c017B5a55075a` |
| FeeSplitter | `0x8cE36Fa4aa2d934cA6aD7bE9de31a8eeFeDf8aE8` |
| BrokerRenderer | `0xB1b64E0CE411135DfaB728a482b21981B07fAd31` |
| BrokerAccount (6551 impl) | `0x32A055D504840E69B7a0B2136264EEF643f6312C` |
| ERC-6551 Registry (canonical) | `0x000000006551c19487814612e58FE06813775758` |

Verified state at deploy: `broker.owner = broker.creator = booster.owner = FeeSplitter.treasury =
deployer 0x9e643731…C440`; `registry.oracleSigner = 0x822864D8…7608e`; `registry` UPDATER_ROLE held
by the deployer; FeeSplitter split `8000/1000/1000` (80/10/10); `broker.mintOpen = false`;
`coat.tradingEnabled = false`; COAT total supply 1e27 held entirely by the deployer (awaiting the
Phase 2 launch). `MAINNET_BROKER_DEPLOYMENT_BLOCK = 39460869`.

**Phase 2 (not yet done):** run `LaunchWithHook` (seeds the pool + locks LP; do **not** call
`enableTrading`), wire the 23 route feeds/routes, upload art + `setRenderer`, then the coordinated
open (`enableTrading()` + `setMintOpen(true)`) per [contracts/DEPLOY.md](contracts/DEPLOY.md) §4.
FeeSplitter `buyback` currently points at the deployer as a placeholder and becomes the BuybackBurner
during Phase 2.

## Active testnet staging (chain 46630)

Clean full redeploy of 2026-08-17 (the previous staging set is superseded). Mint is open at
**0.001 ETH** on this release; the complete 1,776-token renderer collection was uploaded, and
renderer binding (`renderer.broker() == CoattailBroker`) plus mint opening were confirmed on-chain.
All twelve addresses below were re-verified to hold code (`codesize > 0`) against the live chain.

| Component | Address |
|---|---|
| CoattailBroker | `0x2Dc7BAD968061bBb5B19066F3769EC90271e09C7` |
| COAT | `0x1fa24Ce38f1B956ADfe1ffF87d2f1d234844203E` |
| BrokerAccount implementation | `0x386032c56f72Ee4652f651BeA859DB6B5F004CdB` |
| StrategyRegistry | `0x90252Ef04cC9b40d3E684edff9b7ae213e454e6A` |
| ERC-6551 Registry | `0x000000006551c19487814612e58FE06813775758` |
| Booster | `0xE683Db9bbb74a6296Cd24F4e1B8E540C19d6BeA7` |
| StockRouter | `0x76Bdf1a1823d94325e7169805Ecd5BcCA7864CD4` |
| FeeSplitter | `0x9ECe12983b0d2f61d7De59491F952D7EAB2803C0` |
| BrokerRenderer | `0x3013495E7dfE69621e81b488D1F756659Eba019a` |
| CoatFeeHook | `0x72541564B8496E1adD14145cd268f7E1bbc9E044` |
| Permanent LP Locker | `0x49161Ef0362c1317Dc6d3Bb59918BE2DfE0835Ff` |
| CoatRouter | `0x995A4dd800EF2d99550B81097F82fDa79A43208b` |
| BuybackBurner | `0x7FCA13D8baa643310C50BaeDf84BDBaa2Ca227c4` |
| Native ETH/COAT pool ID | `0x335dbf1ee4929ae204ef8d318c80392ab043299802b8ae1ed1443fe140fab4bd` |

The pool ID above was independently confirmed: it equals the `CoatFeeHook.poolId()` immutable read
from chain **and** `keccak256(abi.encode(PoolKey{currency0:0, currency1:COAT, fee:10000,
tickSpacing:200, hooks:CoatFeeHook}))`.

This staging carries the new mint-economics surface: `mintPrice = 0.001 ETH` (owner-lowerable via
`setMintPrice`, down-only), the deployer-only mass `refundHolders(fromId,toId)`, and `cutMintCap`.
Its **live `mintCap` is `500`** — the clean-room E2E exercised `cutMintCap` (1,776 → 500) as part of
the full lifecycle test, so this figure is a deliberate test artefact on staging, not the mainnet
supply (mainnet launches at the full 1,776). The dynamic renderer is wired (`setBroker` +
`setStockTokens`), so `tokenURI` reflects live `Status` and per-TBA stock holdings.

The testnet `StrategyRegistry` is **epoch 1**. The full clean-room E2E drove the entire contract set
end-to-end against the live pool: mint at 0.001 ETH → activation (COAT bought from the live v4 pool)
→ `Status: Active` in metadata → oracle basket (tAAPL 100%) → keeper poke buying tAAPL → claim into
the token-bound account → `"AAPL shares"` rendered in `tokenURI` → transfer flipping `Status` to
`Inactive` while holdings persisted → COAT buy/sell swaps accruing the hook's 1% skim → `flush` →
FeeSplitter 80/10/10 split → `executeBuyback` correctly reverting `InsufficientHistory` on the fresh
pool's TWAP guard → `cutMintCap` → `refundHolders` returning exactly 0.001 ETH. This uses the
inventory-backed test venue only; it is not mainnet route or liquidity evidence.
`StrategyRegistry` and the ERC-6551 registry are distinct contracts; frontend integrations must not substitute one for the other.

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

## Route-ready production universe (23 routes: V1 + V2)

The complete 194-token canonical discovery snapshot lives in `indexer/tokens.py`; canonical status
alone never makes a token purchasable. `indexer/route-ready.mainnet.json` records the **23** routes
that each passed a live mainnet-fork probe (a real 0.001 ETH → stock buy on the live Rialto route with
a valid official guard feed). Other canonical assets stay outside the universe until they independently
pass the same checks. Adding a route needs no redeploy — it is a post-deploy owner op
(`StockRouter.setRoute` + `Booster.setStockFeed`).

**V1 (5) — probe fork block 36869820:**

| Ticker | Canonical token | Stock pool | Guard feed |
|---|---|---|---|
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | `0x957BB4b86CCC706D44983fb889ED63c6F9Bdc662` | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` |
| AMD | `0x86923f96303D656E4aa86D9d42D1e57ad2023fdC` | `0xaF7e236Fd675a4dE1A393516105dB8AFb53DC1EB` | `0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72` |
| AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | `0x3785715B43Ed03Da120f4aE7B23bB1274d5E02Dd` | `0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C` |
| COIN | `0x6330D8C3178a418788dF01a47479c0ce7CCF450b` | `0x33918df3a039312217524491f60e9e69000c30c9` | `0xA3a468A452940B7D6b69991207B508c609a98Ef2` |
| CRCL | `0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5` | `0x2099FEde2Ae9C852c753280b6011E6D622868C08` | `0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a` |

**V2 (18) — all passed the mainnet-fork probe (CI run 32066225360, chain 4663;
`contracts/reports/route-candidate-probe-25777207.json`):**

| Ticker | Canonical token | Stock pool | Guard feed |
|---|---|---|---|
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | `0x682fd352329026885366D6649D61CB4EE505E7A4` | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | `0x08b29F180ae8873897B3b8C2E0EA041172236E63` | `0x4A1166a659A55625345e9515b32adECea5547C38` |
| MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | `0xEE3045339447359e6C021eD63537305DEBDbd610` | `0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E` |
| GOOGL | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | `0x7DA0e2609E8dcf31055A8710465516056CF96E64` | `0xF6f373a037c30F0e5010d854385cA89185AE638b` |
| META | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` | `0xB535F7D16c28Cc86769bE67fa13cdF929c9b5b6d` | `0x7C38C00C30BEe9378381E7B6135d7283356D71b1` |
| PLTR | `0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A` | `0x4bf0949F64739F4e493415bCdAA595Dee6aa9840` | `0x820ABedFF239034956B7A9d2F0a331f9F075eB4c` |
| ORCL | `0xb0992820E760d836549ba69BC7598b4af75dEE03` | `0xFdE9fD3207B26c3607a6eD30b27615C186131698` | `0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844` |
| MU | `0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD` | `0xA84a59b1Bc44E4F99e7aB84Cf68D998f7d5a74e9` | `0x425EEFdCf05ed6526C3cE61Af99429A228a6d596` |
| INTC | `0xc72b96e0E48ecd4DC75E1e45396e26300BC39681` | `0xb1742eDaC0794f792f84e7beb6aB7004e2C26bda` | `0x3f390C5C24628Ac7C489515402235FeAD71D1913` |
| CRWV | `0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3` | `0x67C574d4D5025E93822fC434002d1D36E603D77C` | `0xe1b3aABCAFAd1c94708dc1367dcfF8Aa4407487C` |
| SNDK | `0xB90A19fF0Af67f7779afF50A882A9CfF42446400` | `0x38dd9f56D7b061dffa19f9c9E0930810285A1eD6` | `0xfb133Fa4B7b385802B693a293606682Df47109A3` |
| USAR | `0xd917B029C761D264c6A312BBbcDA868658eF86a6` | `0x4fA3B64Df2756fC6d9d9efef713D9451002e3d58` | `0xA994d3684e8400A6c8078226925779FdeE682DD9` |
| SPCX | `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` | `0x10fF8720e7B2731399838fF3Fe3B73e1D143Aa74` | `0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb` |
| QQQ | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | `0xaF86C97Bce104b1836b9972D20eC7c014D32f47D` | `0x80901d846d5D7B030F26B480776EE3b29374C2ae` |
| SGOV | `0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5` | `0xA6dc89ABa15ba2A4d1757E986d5e85ACD36E27C6` | `0xa0DF4ee0fFf975306345875E3548Fcc519577A11` |
| SLV | `0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f` | `0xE3fedEFadc1B128eC0C40117B2f67E99162ceD4A` | `0x209b73908e92Ae021826eD79609845451Ecba2ce` |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | `0x434dc3ED0aEd78385B34041e7836c867c6790844` | `0x319724394D3A0e3669269846abE664Cd621f9f6A` |
| USO | `0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344` | `0xAA3625Dd1D51e3c5d6EE3576da526982b1ebaA3C` | `0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c` |

The shared WETH/USDG mid pool is `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca`. Rialto is the liquidity venue, not the issuer or owner of the canonical stock tokens.

## Deployment recording rule

After a clean testnet or mainnet deployment, store the generated manifest, parameter hash, chain ID, deployment block and bytecode checks. Never copy addresses manually into the frontend before the manifest passes the wiring checks. Remaining deployment work is listed only in [STATUS.md](STATUS.md).
