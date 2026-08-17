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
pool pair/direction, liquidity, feed and ETH/USD guard all pass. The manifest now carries **23**
fork-probed routes (5 V1 at L2 block `36869820`; 18 V2 at the block in
`reports/route-candidate-probe-25777207.json`, CI run 32066225360). Repeat the probe against the
final deployment and record the new block before opening activation.

## 4. Closed launch → open mint + $COAT together (deploy-day flip)

Goal: deploy the **entire** system, wire it, and verify it on-chain while **both** the NFT mint and
$COAT trading stay shut — then flip both live in one coordinated step at announcement time. This is
fully supported by the contracts; nothing here needs a redeploy.

**Why it works.** `CoattailBroker.mint()` reverts `MintClosed` while `mintOpen == false`
([setMintOpen](src/CoattailBroker.sol) is owner-only, two-way). `COAT._update` reverts
`LaunchBlockBuyBlocked` on every buy out of the PoolManager while `tradingEnabled == false`; only the
`launchController` can call `enableTrading()`, and it is **one-shot** (trading cannot be re-closed).
The anti-snipe protection window is measured from the block `enableTrading()` runs, so the pool can
sit seeded-but-closed for any length of time with no loss of protection.

### 4a. Deploy closed (do NOT open)

1. Run §2 core deploy and `LaunchWithHook.s.sol` (§3.3) as normal — this seeds the pool and locks the
   LP. **Do not call `enableTrading()`.** The launch script only needs to stop short of that call.
2. Leave `mintOpen = false` (it is false on a fresh deploy — do **not** call `setMintOpen`).
3. Complete every other post-deploy step while closed: accept ownership (§3.1), wire all 23
   `setStockFeed` + `setRoute` (§3.2 and below), set the ETH/USD feed, post the first basket (§3.4),
   upload + bind the renderer (§3.6), re-probe routes.

### 4b. Verify the closed state on-chain

```bash
RPC=https://rpc.mainnet.chain.robinhood.com
BROKER=0x...   COAT=0x...   PM=0x8366a39CC670B4001A1121B8F6A443A643e40951
cast call $BROKER "mintOpen()(bool)"            --rpc-url $RPC   # expect false
cast call $COAT   "tradingEnabled()(bool)"      --rpc-url $RPC   # expect false
cast call $COAT   "balanceOf(address)(uint256)" $PM --rpc-url $RPC  # expect > 0 (pool seeded)
# routes/feeds wired while closed — spot-check a couple:
cast call $STOCKROUTER "routeReady(address)(bool)" $NVDA_TOKEN --rpc-url $RPC  # expect true
```

At this point the public site shows the "Launching soon" mint state and no buyable $COAT.

### 4c. Flip both live, together

`enableTrading()` is called by the **launchController** (the address COAT was constructed with);
`setMintOpen(true)` is called by the **owner** (hardware wallet). Send them back-to-back so they land
in the same block / same minute — order does not matter (mint does not depend on trading):

```bash
# 1) open $COAT trading (launchController key). Requires the pool already seeded (4b).
cast send $COAT "enableTrading()" --rpc-url $RPC --private-key $LAUNCH_CONTROLLER_KEY
# 2) open the NFT mint (owner / hardware wallet)
cast send $BROKER "setMintOpen(bool)" true --rpc-url $RPC --private-key $OWNER_KEY
```

If the shared-key launch option is used (owner == deployer == launchController, the accepted-risk
path), both can be issued from the one key in immediate succession, or batched in a tiny script.

### 4d. Verify open + smoke-test, then announce

```bash
cast call $BROKER "mintOpen()(bool)"       --rpc-url $RPC   # expect true
cast call $COAT   "tradingEnabled()(bool)" --rpc-url $RPC   # expect true
cast call $COAT   "launchBlock()(uint64)"  --rpc-url $RPC   # non-zero = protection window armed
```

Only after both read open, do the frontend flip and publish the announcement:

- `frontend/deployments.json` → fill the `mainnet` block with the verified addresses + `poolId`.
- `frontend/src/lib/chains.ts` env: set `NEXT_PUBLIC_NETWORK=mainnet` and
  `NEXT_PUBLIC_RPC_URL_MAINNET` (Alchemy) in Vercel. The build refuses a mainnet config with
  placeholder/zero addresses, so this can only succeed once 4a–4c are done.
- `frontend/src/lib/config.ts` → set `SWAP_ENABLED = true` and ensure `deployments.mainnet.router`
  (CoatRouter) is filled, to reveal the Swap tab. The Mint tab clears its "Launching soon" state on
  its own from the on-chain `mintOpen` flag — no code change needed there.
- Redeploy Vercel, confirm mint + swap are live against mainnet, then post the announcement.

> The mint gate is reversible (`setMintOpen(false)` re-closes it); `enableTrading()` is **not** — once
> $COAT trading opens it stays open. Treat 4c as the irreversible launch moment.
