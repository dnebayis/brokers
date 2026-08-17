# Robinhood Chain addresses

No COAT **mainnet** deployment is recorded yet. The active clean chain-46630 staging deployment is listed below; it is the only address set the frontend may use until mainnet release gates pass.

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
