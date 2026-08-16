# Coattail Brokers — Risk and Disclosure Notes

> This document is general project documentation, not financial or legal advice and not a statement that the system is compliant in every jurisdiction.

Coattail Brokers is a non-custodial protocol on Robinhood Chain. A Broker NFT owns an ERC-6551 wallet. An owner burns COAT to activate reward accrual; protocol swap fees buy third-party tokenized instruments that active Brokers may claim into their wallets. COAT has a fixed initial one-billion supply: the entire supply is deposited into permanent single-sided launch liquidity, with no team or reserve allocation. A permissionless, TWAP-guarded buyback uses the FeeSplitter buyback share and burns purchased COAT. ERC-2981 reports a fixed 2.5% royalty payable directly to the current creator.

## General risk disclosure

- Rewards depend on trading volume and are not guaranteed.
- Smart contracts, oracles, indexers, liquidity pools, wallets and third-party token contracts may fail or behave unexpectedly.
- Tokenized instruments and trading venues are provided by third parties. Their availability, transferability and terms may change.
- Congressional disclosures are delayed and may be corrected; the strategy mirrors disclosed, tokenizable data rather than live positions.
- The project is independent and is not affiliated with or endorsed by Robinhood, members of Congress, data providers or token issuers.
- Users should evaluate applicable obligations and third-party terms for their own circumstances.

The frontend does not implement a blanket access-eligibility gate. This is an implementation statement, not a universal legal conclusion.

The active chain-46630 deployment is a testnet staging environment. Its mint may be open and its
StrategyRegistry holds a deterministic test basket that produced staging stock claims, but no testnet
basket or claim should be presented as a live-product distribution. Mainnet has not been deployed.
