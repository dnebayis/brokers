# Coattail Brokers — canonical release status

_Updated 2026-08-15. This is the only canonical remaining-work list. The active chain-46630 staging deployment is recorded in `ADDRESSES.md`._

## Locked production design

- Collection: 1,776 NFTs, `0.0015 ETH` each, primary wallet cap 2, 2.5% royalty. Fresh deployments start closed; the active testnet staging mint is open.
- Mint IDs: gas-bounded sparse Fisher–Yates draws a unique pseudo-random ID from `1..1776`; a two-NFT mint returns and emits both IDs. It is not VRF and the sequencer can influence block entropy.
- Multi-NFT accounting: every active token ID is one independent share with its own activation, reward debt, pending claim and ERC-6551 account. Two active NFTs burn `73,500 COAT` and earn two shares. A transfer deactivates only the transferred ID while its accrued right and TBA stay with that NFT.
- COAT: fixed initial supply 1B; no team/reserve allocation. The complete supply is launched single-sided into native ETH/COAT Uniswap v4. The 8,393 token-wei Q96 remainder is burned.
- Activation: immutable true burn of `36,750 COAT` per activation; a complete first activation burns `65,268,000 COAT`, leaving at most `934,732,000 COAT` before swap/buyback burns.
- Launch: `1e-8 → 1e-6 ETH/COAT`, 1% LP fee and 1% hook fee. Buy-side hook COAT is truly burned. Sell-side ETH enters the 80/10/10 Booster/treasury/buyback flow.
- Protection: launch-block buys are blocked; the next two blocks enforce 5.5% per-buy output and 5% recipient balance caps. It closes permanently afterward. Sales remain open.
- Atomic launch: the hook accepts pool initialization only from the one-shot launcher; hook deployment, pool initialization, LP token-ID binding and permanent-locker mint are one transaction.
- Liquidity: the v4 position is held by the ownerless permanent locker. Principal cannot be withdrawn or transferred; fees are permissionlessly collected to treasury. Graduation is an informational `pairedPrincipal >= 4.2 ETH` flag and does not migrate the pool.
- Stocks: native ETH is used only for COAT liquidity. Stock purchases use `ETH → WETH → USDG/mid → stock` via StockRouter. Route installation verifies token pairs. Production requires canonical token, working route, sufficient liquidity, guarded feeds and at least 70% live positive-notional coverage.
- Automation: Congress data is refreshed every 6 hours. The independent keeper checks hourly; unsafe/closed/illiquid conditions carry funds forward without invalidating the last good basket.
- Claims: `claim(tokenId)` is owner-only; `claimFor(tokenId)` and batches of at most five are permissionless and can pay only the token's TBA.
- Keys: hardware wallet owner/admin; separate deployer, keeper and oracle signer. `allowUnguarded=false` is enforced on mainnet.

## Completed verification

- All 127 non-fork Solidity tests pass, including unit, 256-run fuzz, 128,000-call supply invariant and the 888-actor local scale suite with a complete random-ID permutation, 1,776 activations and 1,776 claims.
- Production Solidity and deployment scripts pass `forge lint -D notes`; unsafe production casts use checked `SafeCast`. Test-only signed-delta fixtures are explicitly excluded from the production lint target.
- The internal adversarial pass found and fixed launch-settlement fragmentation, sparse-TWAP anchoring, non-atomic pool/LP launch races, oversized buyback/Booster balance liveness and nominal-vs-received stock accounting. Each confirmed path now has a regression test or real-v4 fork proof.
- Current mainnet-fork verification passed 5/5 mandatory component suites: the four core suites at block `36,974,090`, plus all AAPL/AMD/AMZN/COIN/CRCL live routes at block `36,971,715`. This includes the atomic zero-ETH single-sided v4 launch, launch protection, true hook burn, immutable 80/10/10 flow, canonical ERC-6551 account/claim and transfer/reactivation.
- Frontend lint, unit tests, production build and desktop/mobile Chromium E2E pass. Dependency audit reports zero vulnerabilities.
- Indexer unit tests pass. Random-ID claim distribution is cursor-based, resumable, status-checked and capped at five IDs per transaction.
- All 1,776 source/bitmap/trait triples pass the full collection audit with no errors, count mismatches or duplicate bitmaps/sources. Canonical `.bin`/`.traits` payloads have a versioned manifest; aggregate SHA-256: `cfee4e655045cc4cb034433be3ea8ef8a50099072f566515e6d59ffa0b9818d6`.
- All 1,776 canonical payloads also pass production-sized five-token renderer uploads and every generated on-chain `tokenURI`; aggregate tokenURI hash: `0x2b3ac6e4544b0661f1b98b051016823093f694232b7a05c7b81b9f496c4c77c1`.
- A fresh chain-46630 deployment is live. Its 1,776 renderer assets were submitted in 62 receipt-checked transactions, the renderer is bound to the Broker, and `setMintOpen(true)` succeeded. The published testnet addresses are in `ADDRESSES.md` and `frontend/deployments.json`.

## Remaining blockers before GO

- The all-1,776 real-stock mainnet-fork scale run passed against the configured private archive RPC: gas `665,770,258`, AAPL bought `6.083904931373404531`, AAPL claimed `6.083904931373403408`, random-ID permutation hash `0x6d2a89080177251d23ac16f880c2b1dad09e346efaa63f68ae7e53eebf9ba914`.
- The selected five live routes (AAPL, AMD, AMZN, COIN and CRCL) are sufficient for the current product scope. They remain the only permitted route-ready set until a new token independently passes canonical-address, liquidity, feed and fork-probe checks. The indexer must not fabricate or include unguarded routes. Its production coverage gate remains 70% until a separately reviewed parameter decision changes it.
- Add TWAP buyback, graduation, LP fee collection, scale claims and the completed 1,776 renderer proof to one persisted release report. The components have separate proofs, but the required combined artifact is not yet complete.
- Fund and run 888 distinct testnet actors. Every actor must submit one two-NFT mint and resumable activation/claim transactions; every receipt must be `status=1`. Save nonce, cursor, hash, retry, gas percentile and exact reconciliation reports.
- Run wallet-backed frontend E2E against that clean deployment. Current Playwright coverage validates responsive flows/docs, not 888 externally signed chain transactions.
- Run the final remote renderer audit against the active staging renderer: compare every on-chain JSON/SVG/trait/bitmap with `pipeline/collection-manifest.json`. Submission receipts and endpoint checks are complete; this remaining audit is a release-evidence task, not a mint blocker.
- Obtain final owner/deployer/keeper/oracle addresses and production provider keys; fill Vercel environment values without committing secrets. Keep `NEXT_PUBLIC_NETWORK=testnet` until mainnet addresses are verified.
- Independent third-party audit remains strongly recommended. Zero unresolved critical/high internal findings remains mandatory.
- Keep Vercel on testnet staging and promote mainnet mode only after mainnet addresses, provider configuration and all release evidence are verified.
