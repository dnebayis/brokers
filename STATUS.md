# Coattail Brokers — canonical release status

_Updated 2026-08-16. This is the only canonical remaining-work list. It describes the active chain-46630 staging deployment; it is not a mainnet GO notice._

## Locked v1 decisions

- **NFTs:** 1,776 total; `0.0015 ETH` mint; primary mint cap 2; 2.5% ERC-2981 royalty. Fresh deployments start closed. The current testnet mint is open.
- **Random IDs:** sparse Fisher–Yates selection without replacement from `1..1776`. `totalMinted` is a count, never the next token ID. This is pseudo-random, not VRF.
- **Multi-NFT accounting:** every token ID has an independent TBA, activation flag, reward debt and claim. Each activation burns exactly `36,750 COAT`; two active NFTs consume `73,500 COAT` and earn two shares. Transfer deactivates only the transferred NFT.
- **COAT and pool:** fixed 1B initial supply, no team/reserve allocation; native ETH/COAT v4 single-sided liquidity; 1% LP fee + 1% hook fee; sell-side ETH is split 80/10/10. The permanent locker has no principal-withdrawal or position-transfer path. Graduation is informational at `pairedPrincipal >= 4.2 ETH`.
- **Launch protection:** no buy in the opening block; the following two blocks cap a buy at 5.5% of supply and receiver balance at 5%; sales and transfers remain open. The restriction closes permanently after that window.
- **Stocks:** V1 is deliberately limited to five independently fork-probed routes: AAPL, AMD, AMZN, COIN and CRCL. The 194-address Robinhood canonical list is discovery data, not a purchase obligation. A new asset requires canonical-address, route, liquidity, feed and fork-probe verification. The five-token V1 universe is the coverage denominator for V1; unverified canonical assets are excluded, never approximated.
- **Automation:** Congress refresh every six hours; keeper eligibility check every hour; keeper also distributes claims into TBAs. An invalid/new data snapshot cannot replace the last valid basket. Mainnet requires guarded routes (`allowUnguarded=false`).
- **Keys (target):** the owner/admin should be a hardware wallet, with distinct deployer, oracle-signer and keeper keys, and no blockchain private key in the Vercel frontend. **Current reality (2026-08-16):** only a single deployer key exists; the hardware wallet and the separate keeper/oracle identities are not yet created. See blocker 5.
- **Wallet-signing E2E:** dropped as a GO gate (project decision, 2026-08-16). Frontend correctness is covered by contract tests, the render-level E2E suite, the claim-reactivity fix below, and a manual pre-launch click-through instead.

## Evidence currently complete

- **Contracts:** the full non-fork Solidity suite passes — 130 tests across 18 suites (Booster, CoatRouter, CoatFeeHook, FeeSplitter, BuybackBurner, Tokenomics + invariant, Integration, ScaleLifecycle, StockRouter, renderer, locker), run 2026-08-16. CI branch coverage clears its 85% gate.
- **Mainnet fork:** run 2026-08-16 against live RH mainnet — ForkMainnet, ForkLaunch, ForkHook and ForkStockRoutes (all five V1 routes) pass; ForkFullSystem and ForkScaleClaims revert `BadFeed()` only because HEAD was forked on a weekend while the equity feed was stale (see blocker 3). Evidence: `contracts/reports/mainnet-fork-release-2026-08-16.json`.
- **Live testnet system check (2026-08-16):** buy/sell quotes respond; FeeSplitter is wired 80/10/10 with the correct booster and buyback sinks; Booster reports `strategyId 0` and growing `activeShares`; StrategyRegistry is at epoch 1; COAT supply is deflating with activation burns; the launch-protection window is closed. Evidence: `contracts/reports/system-verification-2026-08-16.json`.
- **Indexer:** unit tests pass (12) and an end-to-end sample run produces a valid weighted basket from Congress data against the configured testnet stock addresses. The keeper/distributor/basket scripts share a hardened Web3 provider (`config.make_web3`) that works against the public RPC.
- **Renderer/art:** all 1,776 canonical bitmap/trait payloads pass the collection audit; the active testnet renderer was uploaded in 62 receipt-checked transactions, bound to the Broker, and mint opened.
- **Frontend:** builds, type-checks, lints, unit + render-E2E pass. Reads canonical on-chain artwork, distinguishes BUY from SELL before signing, recovers from a stale wallet restore, finds owned NFTs from Transfer logs, and now auto-refreshes Broker/claim state on a 20s poll so the claim button and balances update without a manual page reload.
- **Testnet basket/claim:** registry epoch 1 holds a deterministic test basket (AMZN 6,196 / AAPL 2,654 / COIN 1,150 bps). Brokers `#487` and `#742` received all three assets into their TBAs via receipt-checked `claimBatch`; their pending balances are zero. A single load actor was additionally taken through mint → activate end-to-end (tokens 853/1000 active on-chain). Evidence: `indexer/reports/testnet-basket-2026-08-15.json`.

## Active testnet facts

- Deployment addresses are in [ADDRESSES.md](ADDRESSES.md) and `frontend/deployments.json`.
- The test venue uses a fixed 2,000 USD/ETH guard whose manual value expires after 30 minutes by design, so staging keeper demonstrations must refresh it before a purchase. Production must use a fresh ETH/USD feed, not this test convenience.
- Testnet stock inventory is a lifecycle venue only; it is not evidence that a mainnet stock route is liquid or guarded.

## Remaining blockers before mainnet GO

1. **888-actor load at scale.** The resumable runner `indexer/testnet_load.py` was fixed (2026-08-16): it presents a browser User-Agent, builds gas estimates from the sender, avoids the EIP-1559/gasPrice conflict, and decodes Minted logs directly. One actor completed fund → mint → buy COAT → approve → activate end-to-end on-chain. Running the full 888 needs a funder wallet with roughly 9+ testnet ETH; persist every nonce, tx, receipt, retry and reconciliation, ignoring no failed receipt.
2. **Transfer → deactivation → reactivation live demo.** Logic is proven in `contracts/test/Integration.t.sol` and `ScaleLifecycle.t.sol` (pass). The live demonstration is scripted in `indexer/transfer_reactivation_check.py`; it needs a source key holding two activated Brokers and a new-owner key funded with COAT + gas.
3. **Clean mainnet-fork release report.** ✅ **CLOSED (2026-08-17).** `mainnet-fork-release.yml`
   (run 32005090190, 7m59s) passed the full **6/6** against the archive Alchemy RPC through the Origin
   proxy: ForkMainnet, ForkLaunch, ForkHook, ForkFullSystem, ForkStockRoutes (all five V1 routes) and
   ForkScaleClaims — the last one drives all 1,776 random IDs to claim real AAPL into distinct TBAs
   (444s). The earlier public-RPC `metadata is not found` was state pruning, not a code/feed failure;
   the archive endpoint resolves it. Deploy scripts compile with the default pipeline (`forge build` clean).
4. **Renderer read-back sweep.** `indexer/renderer_readback_audit.py` reads each token's on-chain bitmap/traits/tokenURI, proves it against the manifest hashes and re-derives the aggregate digest. The offline half and a 3-token on-chain spot check pass; the full 1,776-token sweep is deferred by owner decision. The gate stays open until it reports `failures: 0` and `aggregateMatch: true`.
5. **Production identities and provider credentials.** Owner decision (2026-08-17): deploy with the existing shared deployer key rather than a separate hardware-wallet owner — set `ALLOW_DEPLOYER_OWNER=true`, which the deploy scripts now honor (the role-separation requires stay the default otherwise). Point the mainnet indexer/keeper at the Alchemy RPC with `RH_RPC_ORIGIN=https://www.coattail.cash` (the endpoint is Origin-allowlisted), set `BROKER_DEPLOYMENT_BLOCK` and run `KEEPER_STRICT=1`/`INDEXER_STRICT=1`. Keep Vercel on `NEXT_PUBLIC_NETWORK=testnet` until a verified mainnet manifest exists; the build already refuses a mainnet config with placeholder addresses or a leaked key. Full config list in [MAINNET_READINESS.md](MAINNET_READINESS.md).
6. **Internal finding review.** Resolve every critical/high internal finding before committing real value. Project decision (2026-08-16): no third-party independent audit will be commissioned — a deliberate risk acceptance by the owner that removes an external safety check.

Browser-driven Playwright coverage beyond the render-level suite is not part of the release procedure.
