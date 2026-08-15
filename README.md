# Coattail Brokers

Coattail Brokers is a 1,776-piece ERC-721 collection on Robinhood Chain. Every NFT owns an ERC-6551 account and, while independently activated by a true `36,750 COAT` burn, earns an equal per-token share of fee-funded tokenized-stock purchases based on disclosed US Congress activity.

## Locked v1

- `0.0015 ETH` mint, closed by default, primary cap 2.
- Unique pseudo-random IDs drawn without replacement from `1..1776`; no sequential-ID assumption.
- Fixed 1B COAT supply, no team/reserve allocation, native ETH/COAT Uniswap v4 single-sided launch.
- 1% LP + 1% hook fee; buy-side COAT burns, sell-side ETH splits 80/10/10.
- Permanent ownerless LP locker and informational 4.2 ETH paired-principal graduation.
- Hourly stock keeper, six-hour Congress refresh, fail-closed 70% route-ready coverage gate.
- Owner-only claim plus permissionless non-redirectable `claimFor`/five-ID `claimBatch`.

## Repository

| Area | Purpose |
|---|---|
| `contracts/` | Solidity contracts, launch/deployment scripts, unit/fuzz/invariant/fork tests |
| `indexer/` | Congress aggregation, signed basket publishing, hourly keeper and resumable claims/uploads |
| `frontend/` | Next.js wallet UI and project documentation |
| `pipeline/` | Deterministic 1,776-art validation and canonical bitmap/trait manifest |

The active chain-46630 staging addresses are in [ADDRESSES.md](ADDRESSES.md); the mint is open there and `coattail.cash` must remain in testnet mode until a mainnet manifest is verified. The current release evidence and only canonical remaining-work list are in [STATUS.md](STATUS.md).

## Core checks

```bash
cd contracts
forge fmt --check
forge lint -D notes
forge test --no-match-path 'test/Fork*.t.sol'

cd ../indexer
python3 -m unittest discover -v

cd ../frontend
npm ci
npm run lint
npm test
npm run build
npm run test:e2e
```

The mandatory fork job is intentionally separate and must run with `REQUIRE_MAINNET_FORK=true` and a reliable Robinhood mainnet RPC. Deployment uses `contracts/scripts/deploy_all.sh`, uploads renderer art, binds the renderer, then opens mint only after the release operator checks the deployment.
