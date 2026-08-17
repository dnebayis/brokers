# Coattail Brokers — canonical release status

_Updated 2026-08-17. This is the only canonical remaining-work list. It describes the active chain-46630 staging deployment; it is not a mainnet GO notice._

## Locked v1 decisions

- **NFTs:** 1,776 total; `0.001 ETH` mint; primary mint cap 2; 2.5% ERC-2981 royalty. Fresh deployments start closed. The current testnet mint is open. The mint price is owner-settable **downward only** (including `0` for a free mint), max supply can be **cut** (never raised, never below what is already minted), and buyers can be refunded on-chain for a mint that needs reversing.
- **Random IDs:** sparse Fisher–Yates selection without replacement from `1..1776`. `totalMinted` is a count, never the next token ID. This is pseudo-random, not VRF.
- **Multi-NFT accounting:** every token ID has an independent TBA, activation flag, reward debt and claim. Each activation burns exactly `36,750 COAT`; two active NFTs consume `73,500 COAT` and earn two shares. Transfer deactivates only the transferred NFT.
- **COAT and pool:** fixed 1B initial supply, no team/reserve allocation; native ETH/COAT v4 single-sided liquidity; 1% LP fee + 1% hook fee; sell-side ETH is split 80/10/10. The permanent locker has no principal-withdrawal or position-transfer path. Graduation is informational at `pairedPrincipal >= 4.2 ETH`.
- **Launch protection:** no buy in the opening block; the following two blocks cap a buy at 5.5% of supply and receiver balance at 5%; sales and transfers remain open. The restriction closes permanently after that window.
- **Stocks:** V1 is deliberately limited to five independently fork-probed routes: AAPL, AMD, AMZN, COIN and CRCL. The 194-address Robinhood canonical list is discovery data, not a purchase obligation. A new asset requires canonical-address, route, liquidity, feed and fork-probe verification. The five-token V1 universe is the coverage denominator for V1; unverified canonical assets are excluded, never approximated.
- **Automation:** Congress refresh every six hours; keeper eligibility check every hour; keeper also distributes claims into TBAs. An invalid/new data snapshot cannot replace the last valid basket. Mainnet requires guarded routes (`allowUnguarded=false`).
- **Marketplace metadata:** visual traits remain fixed, but `None` values are omitted from public JSON. Metadata is otherwise dynamic: it reports the Broker's current `Active`/`Inactive` state and the tokenized stocks actually held by its ERC-6551 account (`balanceOf(accountOf(tokenId))`), formatted with ERC-8056 decimals/`uiMultiplier`. Booster `claimable` balances are pending entitlements and are never presented as wallet holdings. The contract emits ERC-4906 refresh signals on activation, transfer-triggered deactivation, successful claim and Broker-executed withdrawal.
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

1. **888-actor load at scale.** ✅ **CLOSED as a GO gate (owner decision, 2026-08-17).** 1,776-scale
   accounting is already proven at the contract level (`ScaleLifecycle.t.sol`, `Integration.t.sol`) and
   end-to-end on the live mainnet fork (`ForkScaleClaims` drives all 1,776 random IDs to claim real
   AAPL into distinct TBAs — 6/6 CI, blocker 3). The resumable runner `indexer/testnet_load.py` is
   fixed and one actor completed fund → mint → buy COAT → approve → activate on-chain; a full 888-actor
   live run needs ~9 testnet ETH in a funder wallet (`LOAD_FUNDER_PRIVATE_KEY`) and can be run
   post-launch if desired, but it is no longer a launch blocker.
2. **Transfer → deactivation → reactivation live demo.** Logic is proven in `contracts/test/Integration.t.sol` and `ScaleLifecycle.t.sol` (pass). The live demonstration is scripted in `indexer/transfer_reactivation_check.py`; it needs a source key holding two activated Brokers and a new-owner key funded with COAT + gas.
3. **Clean mainnet-fork release report.** ✅ **CLOSED (2026-08-17).** `mainnet-fork-release.yml`
   (run 32005090190, 7m59s) passed the full **6/6** against the archive Alchemy RPC through the Origin
   proxy: ForkMainnet, ForkLaunch, ForkHook, ForkFullSystem, ForkStockRoutes (all five V1 routes) and
   ForkScaleClaims — the last one drives all 1,776 random IDs to claim real AAPL into distinct TBAs
   (444s). The earlier public-RPC `metadata is not found` was state pruning, not a code/feed failure;
   the archive endpoint resolves it. Deploy scripts compile with the default pipeline (`forge build` clean).
4. **Renderer read-back sweep.** ✅ **CLOSED (2026-08-17).** `indexer/renderer_readback_audit.py` swept
   all 1,776 tokens on the live testnet renderer (`0x87af…4739`): `audited: 1776`, `failures: 0`,
   `aggregateMatch: true` — the on-chain aggregate digest equals the manifest
   (`cfee4e655045cc4cb034433be3ea8ef8a50099072f566515e6d59ffa0b9818d6`). Evidence:
   `indexer/reports/renderer-readback-2026-08-17.json`. Re-run against the mainnet renderer after upload.
5. **Production identities and provider credentials.** Owner decision (2026-08-17): deploy with the existing shared deployer key rather than a separate hardware-wallet owner — set `ALLOW_DEPLOYER_OWNER=true`, which the deploy scripts now honor (the role-separation requires stay the default otherwise). Point the mainnet indexer/keeper at the Alchemy RPC with `RH_RPC_ORIGIN=https://www.coattail.cash` (the endpoint is Origin-allowlisted), set `BROKER_DEPLOYMENT_BLOCK` and run `KEEPER_STRICT=1`/`INDEXER_STRICT=1`. Keep Vercel on `NEXT_PUBLIC_NETWORK=testnet` until a verified mainnet manifest exists; the build already refuses a mainnet config with placeholder addresses or a leaked key. Full config list in [MAINNET_READINESS.md](MAINNET_READINESS.md).
6. **Internal finding review.** Resolve every critical/high internal finding before committing real value. Project decision (2026-08-16): no third-party independent audit will be commissioned — a deliberate risk acceptance by the owner that removes an external safety check.

7. **Final static + dynamic metadata renderer.** 🟡 **Built + unit-proven (2026-08-17); remote read-back
   pending a fresh deployment.** `BrokerRenderer` now omits `None` traits, reads live `Status`
   Active/Inactive from the Broker, and lists TBA holdings from `balanceOf(accountOf(tokenId))` over a
   bounded owner-set V1 stock list (never `claimable`), formatted with ERC-8056 decimals/`uiMultiplier`.
   `CoattailBroker` emits EIP-4906 `MetadataUpdate` on activate, transfer/deactivate and (via the
   Booster) on claim, plus an owner/TBA-callable `refreshMetadata` for withdrawals; `supportsInterface`
   reports `0x49064906`. `test/RendererDynamic.t.sol` (7 tests) covers None omission, status, holdings
   vs claimable, holdings persisting across transfer, the ERC-4906 events, a bounded-gas/valid-shape
   check and the full #742-style lifecycle (inactive → active → accrue → claim → hold → withdraw →
   transfer → reactivate). **Remaining:** deploy this renderer, wire `setBroker`/`setStockTokens`, then
   run the full 1,776-ID remote read-back (schema + gas/size) against it — the on-chain staging renderer
   currently deployed is still the old static one, so it is **not** final evidence. Carry into mainnet.
   The historical static-art read-back (blocker 4) remains ✅ for the art bytes, which are unchanged.
   - Omit every optional attribute whose value is `None`; keep the locked art, token IDs, trait bytes and
     rarity counts unchanged.
   - Add `Status: Active|Inactive`, sourced from the Broker's canonical per-token activation state
     (Broker and Booster activation state must stay equal).
   - Read holdings from `balanceOf(Broker.accountOf(tokenId))` — not the NFT owner's wallet, not
     `Booster.claimable(tokenId)`.
   - Publish each non-zero V1 stock as a holding; where a balance is shown, format it with the ERC-8056
     token decimals and `uiMultiplier` — never label a raw balance as a display-share balance.
   - Use a bounded, deployment-verified V1 stock-token list. `tokenURI` must not loop arbitrary wallet
     tokens or an unbounded registry. A stock-universe expansion requires an explicit renderer/version bump.
   - Emit ERC-4906 metadata-refresh signals from the NFT contract after activation, transfer-triggered
     deactivation, a successful Booster claim and a Broker-executed stock withdrawal.
   - Document the cache limit: an ERC-20 sent directly into the TBA cannot notify the NFT contract;
     `tokenURI` still returns the correct live balance on reread, but a marketplace may need a manual refresh.
   - Claimed holdings stay attached across a transfer unless the seller withdrew them; transfer flips status
     to `Inactive`, not the TBA balances. Pending claimable stays separately accounted until claimed.
   - Acceptance: token #742 (and one empty-TBA Broker) through inactive → active → accrue → claim → hold →
     withdraw → transfer → reactivate. No response carries a `None` attribute; holdings appear only after
     claim, vanish after withdrawal, survive a transfer when left in the TBA, and status follows every step.
   - Run all-1,776 `tokenURI` generation + gas/size tests, marketplace JSON-schema tests, ERC-4906
     interface/event tests and remote read-back before marking complete.

8. **Frontend "Your Broker's wallet" lifecycle acceptance.** Most of this shipped (owned-ID discovery
   from Transfer logs, claimable-driven claim/withdraw, 20s silent refetch without reload, receipt-boundary
   refresh). Remaining: a working full-TBA-address copy control (Clipboard API + fallback, copies the full
   address never the shortened label), and a formal multi-Broker acceptance run — selector shows exactly the
   owned active+inactive Brokers, switching IDs updates address/status/claimable/holdings, a fresh empty TBA
   can claim, balances update after the successful receipt without reload, and a failed receipt leaves the
   displayed state unchanged while showing the error.

Browser-driven Playwright coverage beyond the render-level suite is not part of the release procedure.
