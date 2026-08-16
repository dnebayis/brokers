# Coattail Brokers — canonical release status

_Updated 2026-08-15. This is the only canonical remaining-work list. It describes the active chain-46630 staging deployment; it is not a mainnet GO notice._

## Locked v1 decisions

- **NFTs:** 1,776 total; `0.0015 ETH` mint; primary mint cap 2; 2.5% ERC-2981 royalty. Fresh deployments start closed. The current testnet mint is open.
- **Random IDs:** sparse Fisher–Yates selection without replacement from `1..1776`. `totalMinted` is a count, never the next token ID. This is pseudo-random, not VRF.
- **Multi-NFT accounting:** every token ID has an independent TBA, activation flag, reward debt and claim. Each activation burns exactly `36,750 COAT`; two active NFTs consume `73,500 COAT` and earn two shares. Transfer deactivates only the transferred NFT.
- **COAT and pool:** fixed 1B initial supply, no team/reserve allocation; native ETH/COAT v4 single-sided liquidity; 1% LP fee + 1% hook fee; sell-side ETH is split 80/10/10. The permanent locker has no principal-withdrawal or position-transfer path. Graduation is informational at `pairedPrincipal >= 4.2 ETH`.
- **Launch protection:** no buy in the opening block; the following two blocks cap a buy at 5.5% of supply and receiver balance at 5%; sales and transfers remain open. The restriction closes permanently after that window.
- **Stocks:** V1 is deliberately limited to five independently fork-probed routes: AAPL, AMD, AMZN, COIN and CRCL. The 194-address Robinhood canonical list is discovery data, not a purchase obligation. A new asset requires canonical-address, route, liquidity, feed and fork-probe verification. The five-token V1 universe is therefore the coverage denominator for V1; unverified canonical assets are excluded, never approximated.
- **Automation:** Congress refresh every six hours; keeper eligibility check every hour. An invalid/new data snapshot cannot replace the last valid basket. Mainnet requires guarded routes (`allowUnguarded=false`).
- **Keys:** the owner/admin is the designated hardware wallet. Deployer, oracle signer and keeper are distinct keys. No blockchain private key belongs in the Vercel frontend.

## Evidence currently complete

- Non-fork Solidity unit/fuzz/invariant suites, random-ID and multi-NFT coverage pass locally.
- The mainnet fork component suites and all five V1 stock-route probes have passed with the configured archive RPC. This is route evidence, not a mainnet deployment.
- All 1,776 canonical bitmap/trait payloads pass the collection audit. The active testnet renderer was uploaded in 62 receipt-checked transactions, bound to the Broker, and the staging mint was opened.
- The frontend builds, type-checks, lints and runs its non-browser unit checks. It reads canonical on-chain artwork, distinguishes BUY from SELL before requesting a signature, recovers from a stale wallet restore, and finds owned NFTs from Transfer logs rather than a 1,776-ID scan.
- CI branch coverage now clears its 85% gate: `BuybackBurner` 100%, `COAT` 90%, `CoatFeeHook` 88% and `CoatRouter` 87.5%.
- A test-only basket was posted as registry epoch 1: AMZN 6,196 bps, AAPL 2,654 bps and COIN 1,150 bps. The hook → splitter → Booster purchase succeeded and receipt-checked `claimBatch([487,742])` delivered all three test assets to both corresponding TBAs. Evidence is in `indexer/reports/testnet-basket-2026-08-15.json` and [ADDRESSES.md](ADDRESSES.md).

## Active testnet facts

- The deployment addresses are in [ADDRESSES.md](ADDRESSES.md) and `frontend/deployments.json`.
- The staging `StrategyRegistry` is at **epoch 1** with the three-asset deterministic test basket above. Brokers `#487` and `#742` have independently received AMZN, AAPL and COIN into their TBAs; their post-claim pending balances are zero.
- The test venue uses a fixed 2,000 USD/ETH guard input. Its manual guard expires after 30 minutes by design, so staging keeper demonstrations must refresh it before a new purchase. Production must use a fresh ETH/USD feed, not this test convenience.
- Testnet stock inventory is a lifecycle venue only. It is not evidence that a mainnet stock route is liquid or guarded.

## Remaining blockers before mainnet GO

1. Run the resumable 888-actor testnet load process: one `mint(2)` per actor, activation, keeper purchase and claim distribution. Persist every nonce, transaction hash, receipt, retry and reconciliation result. No failed receipt may be ignored.
2. Complete the representative testnet transfer → deactivation → reactivation check after the successful claim cycle, proving that only the transferred token's accounting changes.
3. Produce one final mainnet-fork release report combining launch, protection, five V1 routes, stock claims, buyback/TWAP, graduation, LP-fee collection, supply/reward reconciliation and the renderer hash audit. Partial run 2026-08-16 against live mainnet HEAD (`contracts/reports/mainnet-fork-release-2026-08-16.json`): 4/6 fork suites pass — ForkMainnet, ForkLaunch, ForkHook and ForkStockRoutes (all five V1 routes). ForkFullSystem and ForkScaleClaims revert `BadFeed()` because the run forked a Sunday HEAD while the AAPL equity feed last updated the prior Friday (~2.1 days > the 1-day staleness window) — a market-calendar artifact, confirmed by reading the feed's on-chain `updatedAt`, not a code regression. A clean 6/6 needs a US-market-hours weekday fork with fresh equity feeds; the public RPC prunes historical state, so the final report run needs an archive RPC or a live market-hours run.
4. Complete the remote read-back audit of every active testnet renderer JSON/SVG/trait/bitmap against `pipeline/collection-manifest.json`. Tooling is ready: `indexer/renderer_readback_audit.py` reads each token's on-chain `bitmapOf`/`traitsOf`/`tokenURI`, proves it against the manifest hashes, re-derives the aggregate digest and writes a per-token report. The offline half (local collection vs manifest) verifies clean, and a 3-token on-chain spot check matched. The full 1,776-token on-chain sweep is deferred by owner decision (2026-08-16); until it is run and reports `failures: 0` with `aggregateMatch: true`, this gate is open.
5. Configure production owner/deployer/keeper/oracle identities and provider credentials. Keep Vercel on `NEXT_PUBLIC_NETWORK=testnet` until a verified mainnet manifest exists.
6. Resolve every critical/high internal finding before committing real value. Project decision (2026-08-16): no third-party independent audit will be commissioned; the release relies on the internal finding review only. This removes an external safety check and is a deliberate risk acceptance by the owner.
7. Frontend E2E is a required GO gate (project decision, 2026-08-16). The current `frontend/e2e/app.spec.ts` suite passes: 4 tests (chromium + mobile-chromium) covering mint/activate/docs flow visibility and the multi-Broker accounting copy, run 2026-08-16. This suite proves the UI renders the locked-v1 rules; it does **not** yet exercise a live-signing wallet (BUY-vs-SELL signing, activation and claim receipts) end-to-end. Before GO, extend the suite with wallet-backed signing coverage against the staging deployment and record `success` receipts, or explicitly accept the render-only gate.

Item 7's frontend E2E is the required gate; other browser-driven Playwright coverage beyond that suite is not part of the release procedure.
