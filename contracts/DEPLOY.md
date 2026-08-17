# Deploy runbook — Coattail Brokers

The publication entrypoint is `scripts/deploy_all.sh`. It performs multiple receipt-checked
transactions under one command: core contracts, the chain-46630-only test stock venue when
applicable, then the native ETH/COAT v4 launch and permanent locker. The complete release is
multiple receipt-checked transactions, while the race-sensitive hook deployment + guarded pool
initialization + LP ID binding + locker mint is one `AtomicV4Launcher.launch` transaction. Mint
remains closed afterward.

The whole wired lifecycle (mint → activate → poke → claim → transfer → re-activate) is
proven end-to-end in `test/Integration.t.sol` against real ERC-6551 wallets.

## What it does

Deploys `BrokerAccount`, `COAT`, `StrategyRegistry`, `CoattailBroker`, `StockRouter`, `Booster`,
`BrokerRenderer`, `FeeSplitter`; wires Broker↔Booster↔COAT; sets the oracle signer +
drift cap + optional manual ETH/USD; then (if `OWNER` ≠ deployer) hands every owner/admin
to the hardware wallet **2-step** (it must `acceptOwnership()` after). `DeployTestnetVenue`
can execute only on chain 46630 and installs test USDG, five test stocks, fixed feeds and
inventory-funded WETH→USDG→stock routes.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `PRIVATE_KEY` | — (required) | separate deployer key; must not be the mainnet owner |
| `OWNER` | deployer | owner/admin for all contracts — the single hardware wallet |
| `TREASURY` | deployer | project treasury — 10% fee sink (NOT mint; mint → `creator`) |
| `CREATOR` | `TREASURY` | mint-proceeds and ERC-2981 royalty wallet; passed to Broker at deployment and rotatable via `setCreator` |
| `BUYBACK` | deployer | temporary contract sink used until `LaunchWithHook` deploys and wires `BuybackBurner`; mainnet cannot use an EOA |
| `UPDATER` | deployer | indexer relayer / ops role (`UPDATER_ROLE`) |
| `ORACLE_SIGNER` | deployer | separate EIP-712 signing key (`oracleSigner`) |
| `MAX_DRIFT_BPS` | 10000 (off) | per-epoch basket turnover cap |
| `ETH_USD_E8` | 0 (skip) | manual ETH/USD (8-dec) for slippage guard |
| `BASE_URI` | `ipfs://coattail/` | pre-art token URI |
| `ERC6551_REGISTRY` / `WETH` | mainnet values | **override for testnet** |

## 1. Testnet dry-run (chain 46630)

> First confirm the testnet ERC-6551 registry / WETH / Uniswap router addresses and pass
> them as env. If the canonical 6551 registry isn't on testnet, deploy one (or use a local
> clone) — `test/Mocks.sol:TestERC6551Registry` is byte-identical to the canonical proxy.

`PRIVATE_KEY` is a Foundry/deployment secret only. It is never a Vercel variable and must never be
named `NEXT_PUBLIC_PRIVATE_KEY` or included in a frontend build.

```bash
cd contracts
RH_RPC_URL="$RH_TESTNET_RPC" PRIVATE_KEY=0x... \
OWNER=0x<hardware> ERC6551_REGISTRY=0x<testnet> WETH=0x<testnet> \
MAX_DRIFT_BPS=3000 ETH_USD_E8=300000000000 scripts/deploy_all.sh
```

The command writes deployment and test-venue manifests but does not open mint. Post the first
valid strategy, accept ownership, verify every address/feed/route and only then call
`setMintOpen(true)` from the hardware wallet.

## 2. Mainnet

```bash
PRIVATE_KEY=0x... OWNER=0x<safe> TREASURY=0x<safe> BUYBACK=0x<safe> \
UPDATER=0x<indexerKey> ORACLE_SIGNER=0x<indexerKey> MAX_DRIFT_BPS=3000 \
RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com scripts/deploy_all.sh
```

## 3. Post-deploy checklist

> Ownership model: a single hardware wallet owns the admin contracts. Keep deployer,
> keeper and oracle/updater keys separate. The permanent LP locker has no owner.

1. Confirm the hardware wallet has accepted the pending ownership of Broker / Booster /
   StockRouter / Renderer / FeeSplitter and holds `StrategyRegistry` admin. Confirm the deployer
   holds none of those roles afterward. `LaunchWithHook.s.sol` wires FeeSplitter's BuybackBurner
   before that acceptance step.
2. **Slippage feeds:** `booster.setStockFeed(token, chainlinkStockFeed)` for every basket
   token. For ETH/USD, prefer `booster.setEthUsdFeed(...)`: Robinhood Chain publishes Chainlink
   crypto feeds (including ETH/USD) — read the current proxy address from the official feeds page
   (docs.chain.link Robinhood network / docs.robinhood.com chain oracles) rather than hardcoding.
   `setEthUsdManual(...)` (refreshed within its 30-minute window) is only a fallback if the live
   feed is temporarily unavailable.
3. **Launch $COAT:** use `script/LaunchWithHook.s.sol` to deploy the hook, v4 pool,
   permanent CoatRouter and BuybackBurner, then wire the splitter's 10% sink. Set
   `HOOK_OWNER` = hardware wallet. Its one-shot atomic launcher prevents pool-price and global
   PositionManager token-ID races, and mints the position directly to the permanent locker.
   This must precede activation.
4. **Oracle:** point the indexer at `oracleSigner`; post the first basket
   (`setStrategyWithSig`). Confirm `epochOf(0) == 1`.
5. **Verify wiring:** confirm `FeeSplitter.buyback()` is the new BuybackBurner, the hardware
   wallet owns FeeSplitter and the hook, and the deployer no longer owns either admin surface.
6. **Art:** upload all reviewed bitmaps/traits, verify every token is uploaded, then
   `broker.setRenderer(renderer)`. Before that, `tokenURI` must remain on the fallback.
7. **Royalty:** confirm `royaltyInfo` returns 2.5% to current `creator`; do not point
   NFT royalty at FeeSplitter.
8. Record all addresses and keeper stage addresses in [ADDRESSES.md](../ADDRESSES.md).

Before opening activation, configure the in-repo StockRouter and probe every route in
`indexer/route-ready.mainnet.json`. A route is not publishable until its canonical token,
pool pair/direction, liquidity, feed and ETH/USD guard all pass. The five current manifest
routes passed against live Rialto pools at L2 block `36869820`; repeat the probe against the
final deployment and record the new block before opening activation.
