# Coattail Brokers

Coattail Brokers is a 1,776-piece ERC-721 collection on Robinhood Chain. Every NFT owns an ERC-6551 account and, while independently activated by a true `36,750 COAT` burn, earns an equal per-token share of fee-funded tokenized-stock purchases based on disclosed US Congress activity.

**Live on mainnet (chain 4663) since 2026-08-18.** The collection is sold out (1,776/1,776), $COAT trades, and the engine buys the disclosed-Congress basket every hour. Two products run on top of it: **The Floor**, a public terminal that trades the whole basket in one transaction, and **Playbooks**, standing orders the engine executes for your Broker. Every address is in [ADDRESSES.md](ADDRESSES.md); every contract is source-verified on `https://robinhoodchain.blockscout.com`.

## Locked v1

- `0.001 ETH` mint, closed by default, primary cap 2.
- Unique pseudo-random IDs drawn without replacement from `1..1776`; no sequential-ID assumption.
- Fixed 1B COAT supply, no team/reserve allocation, native ETH/COAT Uniswap v4 single-sided launch.
- 1% LP + 1% hook fee; buy-side COAT burns, sell-side ETH splits 80/10/10.
- Permanent ownerless LP locker and informational 4.2 ETH paired-principal graduation.
- Hourly stock keeper, six-hour Congress refresh and a fixed five-stock V1 route-ready universe.
- Owner-only claim plus permissionless non-redirectable `claimFor`/five-ID `claimBatch`.

## Products on top of the engine

- **The Floor** (`exchange-floor/`) — one-transaction entry and exit for the live Congress basket, paying in $COAT, ETH or USDG. Chainlink-guarded per leg, non-custodial, 0.3% fee of which 80% is converted to native ETH and streamed into Broker payroll.
- **Playbooks** (`playbooks/`) — per-Broker standing orders the hourly keeper executes: auto-claim the salary, sweep it, or convert it to USDG/$COAT and deliver it anywhere. Owner-installed, revocable, and self-invalidating on transfer. No fee of its own; conversions ride The Floor.

## Repository

| Area | Purpose |
|---|---|
| `contracts/` | Solidity contracts, launch/deployment scripts, unit/fuzz/invariant/fork tests |
| `indexer/` | Congress aggregation, signed basket publishing, hourly keeper and resumable claims/uploads |
| `frontend/` | Next.js wallet UI and project documentation |
| `pipeline/` | Deterministic 1,776-art validation and canonical bitmap/trait manifest |
| `exchange-floor/` | The Floor: `BasketRouter` venue, unit/fork suites, deploy scripts |
| `playbooks/` | Playbooks: `PlaybookEngine`, unit suite, deploy scripts |

Mainnet (chain 4663) and chain-46630 staging addresses are both in [ADDRESSES.md](ADDRESSES.md). `coattail.cash` serves mainnet. Current system state is in [STATUS.md](STATUS.md).

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
```

The mandatory fork job is intentionally separate and must run with `REQUIRE_MAINNET_FORK=true` and a reliable Robinhood mainnet RPC. The Floor and Playbooks carry their own suites, including fork tests that exercise the **deployed** mainnet contracts:

```bash
cd exchange-floor && forge test --match-path 'test/Fork*' --fork-url https://rpc.mainnet.chain.robinhood.com
cd ../playbooks && forge test
```

Current system state is in [STATUS.md](STATUS.md); the historical deploy-day sequence is in [MAINNET_READINESS.md](MAINNET_READINESS.md).
