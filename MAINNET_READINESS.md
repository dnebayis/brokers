# Coattail Brokers — mainnet deploy readiness

_Updated 2026-08-17. Pre-deploy GO checklist and deploy-day sequence. Mechanics live in
[contracts/DEPLOY.md](contracts/DEPLOY.md); the canonical remaining-work list is [STATUS.md](STATUS.md).
This is not a GO notice — it is the readiness board the owner works through before broadcasting._

## Verified this session (2026-08-16 → 17)

- **Contracts:** non-fork suite 130/130 pass. Deploy scripts compile with the default pipeline
  (`forge build --skip test` clean) — the `LaunchWithHook` stack-too-deep that would have broken a
  mainnet launch is fixed, with no contract bytecode change.
- **Deploy script (`Deploy.s.sol`) dry-run:** simulated end-to-end against the live **testnet** fork —
  full deploy + wiring, every post-deploy assert (supply, liquidity allocation, wiring, creator,
  80/10/10 split) passes, and the distinct-owner run exercises the 2-step ownership handoff
  (transferOwnership + registry admin grant/renounce + pending-owner asserts). ~17.4M gas. The
  mainnet-state dry-run (chain-4663 canonical-dependency + shared-key guard) is staged as the
  `mainnet-deploy-dryrun.yml` CI job, to dispatch once it reaches the default branch.
- **Mainnet fork (live RH mainnet, archive RPC via CI):** ✅ **full 6/6** — `mainnet-fork-release.yml`
  run 32005090190 (7m59s) passed ForkMainnet, ForkLaunch, ForkHook, ForkFullSystem, ForkStockRoutes
  (all five V1 routes) and ForkScaleClaims. The last one drives all 1,776 random IDs to claim real
  AAPL into distinct TBAs (444s). The earlier public-RPC `metadata is not found` was historical-state
  pruning; the archive Alchemy RPC (through the Origin proxy, with fork retries) resolves it.
- **Automation (GitHub Actions, green):** the indexer posts a real oracle-signed Congress basket
  on-chain (epoch advanced), and the keeper runs the flush → split → poke → buyback → claim
  distribution path. Five integration bugs found and fixed along the way (secret scope, `1E+15`
  env parse, distributor timeout, Unusual Whales date format, coverage gate).
- **Live testnet system check:** buy/sell quotes, FeeSplitter 80/10/10 sinks, Booster shares,
  registry epoch, deflating COAT supply and the closed launch-protection window all confirmed.

## Hard GO gates (status)

| Gate | Status |
|---|---|
| Non-fork contract suite + coverage | ✅ 130/130, 85% branch gate |
| Mainnet-fork release report (clean 6/6) | ✅ full 6/6 in CI (run 32005090190) against the archive Alchemy RPC |
| Deploy scripts compile + dry-run | ✅ compile fixed; `Deploy.s.sol` simulates clean on the testnet fork (shared-key **and** 2-step owner-handoff paths). Mainnet-state dry-run staged as `mainnet-deploy-dryrun.yml` (dispatch after it lands on the default branch) |
| 888-actor testnet load at scale | ✅ dropped as a GO gate (2026-08-17) — 1,776-scale proven by ScaleLifecycle/Integration tests + ForkScaleClaims 6/6; live 888 run is optional/post-launch |
| Renderer read-back sweep | ✅ full 1,776 swept on testnet — 0 failures, aggregate matches manifest (re-run on the mainnet renderer post-upload) |
| Internal critical/high finding review | 🟡 owner accepted no third-party audit; close internal findings |
| Production identities configured | 🔴 owner action (below) |

## Before you broadcast — owner actions

1. **Create the production keys.** Separate, never shared:
   - **Owner/admin → hardware wallet** (Ledger/Trezor). This holds Broker/Booster/StockRouter/
     Renderer/FeeSplitter/hook admin. Set `OWNER` and `HOOK_OWNER` to it.
   - **Deployer** — a funded EOA that runs the deploy, then hands ownership 2-step to the hardware
     wallet and is discarded (`PRIVATE_KEY`).
   - **Keeper** — gas-funded, no on-chain role (`TESTNET_KEEPER_PRIVATE_KEY` → a mainnet equivalent).
   - **Oracle signer** — signs baskets; must equal the registry `oracleSigner`.
2. **Wire the price feeds after deploy** (see DEPLOY.md §3.2):
   - `booster.setStockFeed(token, feed)` for each of the five V1 tokens — addresses from
     `indexer/route-ready.mainnet.json`. These auto-update; no refresher.
   - `booster.setEthUsdFeed(<ETH/USD proxy>)` — RH Chain publishes a Chainlink ETH/USD feed; read the
     current proxy from the official feeds page. (`setEthUsdManual` + refresh is a fallback only.)
3. **Re-probe the five routes** against the final mainnet deployment and record the block before
   opening activation.
4. **Set the GitHub Actions secrets** for the mainnet indexer/keeper (a Congress API key, the mainnet
   keeper and oracle keys, addresses) and switch the schedule env to mainnet.
5. **Keep Vercel on `NEXT_PUBLIC_NETWORK=testnet`** until a verified mainnet manifest exists — the
   frontend build already refuses a mainnet config with placeholder addresses or a leaked key.

## Mainnet env/config (from the code review)

These are the settings the mainnet deploy and automation need that differ from testnet:

- **Deploy scripts:** set `ALLOW_DEPLOYER_OWNER=true` to deploy with a shared deployer/owner key
  (owner's accepted risk); without it the mainnet deploy reverts requiring distinct roles.
- **Indexer/keeper RPC:** point `RH_RPC_URL` at the Alchemy mainnet endpoint and set
  `RH_RPC_ORIGIN=https://www.coattail.cash` — the endpoint is allowlisted to that Origin and rejects
  server-side calls without it. Use Alchemy (RPC + NFT API), not the public RPC.
- **Claim distributor:** set `BROKER_DEPLOYMENT_BLOCK` to the mainnet Broker deploy block. It defaults
  to 0 on mainnet, which makes the mint-discovery `getLogs` scan the whole chain and can be rejected.
- **Strict mode:** run the mainnet keeper and indexer with `KEEPER_STRICT=1` and `INDEXER_STRICT=1`
  so a genuinely deferred poke, stale feed or thin-coverage refusal fails loudly instead of warning.
- **CI fork release:** `mainnet-fork-release.yml` now forks the archive Alchemy RPC through the
  Origin proxy — repo secret `RH_MAINNET_RPC_URL` and variable `RH_RPC_ORIGIN` are set.
- **Frontend:** the Swap tab is hidden behind `SWAP_ENABLED=false` until the CA is public; keep
  `NEXT_PUBLIC_NETWORK=testnet` until a verified mainnet manifest exists.

## Deploy sequence — critical contracts first, then token + NFT (owner-gated)

Per the deploy plan, do **not** deploy everything at once. Deploy and verify the critical contracts
first; deploy the COAT token and the Broker NFT only after explicit approval.

1. **Phase 1 — critical infrastructure:** deploy and verify the registry/account/booster/router/
   splitter/renderer core (mint stays closed, no token/NFT economic launch yet). Check every address,
   role and wiring on-chain.
2. **Phase 2 — token + NFT (requires approval):** only after Phase 1 is checked and approved, deploy
   COAT, run the v4 launch (`LaunchWithHook`), and open the Broker NFT mint.

## Deploy-day sequence (mechanics in DEPLOY.md)

1. **Dry-run** `deploy_all.sh` / `LaunchWithHook` against a mainnet fork; review the manifest.
2. **Broadcast core** — `scripts/deploy_all.sh` deploys BrokerAccount, COAT, StrategyRegistry,
   CoattailBroker, StockRouter, Booster, BrokerRenderer, FeeSplitter and wires them. Mint stays closed.
3. **Launch $COAT** — `script/LaunchWithHook.s.sol` mines the flag-valid hook, atomically initializes
   the guarded v4 pool, mints LP to the permanent locker, burns the rounding remainder, opens the
   one-shot protection window, deploys CoatRouter + BuybackBurner and wires the 10% sink.
4. **Accept ownership** — the hardware wallet `acceptOwnership()` on every admin contract; confirm the
   deployer holds no roles afterward.
5. **Wire feeds** (owner action 2), **post the first basket** via the oracle (`setStrategyWithSig`,
   confirm `epochOf(0) == 1`), **probe routes** (owner action 3).
6. **Upload + bind renderer**, verify every token, then `broker.setRenderer(renderer)`. Also wire the
   dynamic metadata: `renderer.setBroker(broker)` and `renderer.setStockTokens([5 V1 tokens],[symbols])`
   so `Status` and TBA holdings render. Then run the full 1,776-ID remote read-back (schema + gas/size)
   against the deployed renderer before opening mint (blocker 7).
7. **Open activation / mint** only after the release operator checks every address, feed and route.
8. Record all addresses in [ADDRESSES.md](ADDRESSES.md) and the verified mainnet manifest in
   `frontend/deployments.json`; only then flip Vercel to mainnet.

## Post-deploy verification

- Confirm `royaltyInfo` returns 2.5% to `creator`; `FeeSplitter.buyback()` is the BuybackBurner; the
  hardware wallet owns FeeSplitter and the hook; the deployer owns neither.
- Confirm the permanent locker holds the LP position and has no principal-withdrawal path.
- Run one live keeper cycle (flush → poke → distribute) and one claim/withdraw from the frontend.
