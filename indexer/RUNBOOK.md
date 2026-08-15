# Indexer and reward keeper runbook

## Locked operating policy

- Poll Congress disclosures every 6 hours.
- Build a deterministic 90-day net-buy basket.
- Post a new Registry epoch only when the canonical token/weight vector changed.
- Never post sample, thin, single-trader, stale, empty, or malformed live data.
- A day with no new Congress disclosure does not pause purchases. Keep the last
  valid on-chain basket active and continue buying it whenever fees reach the
  threshold. A later valid basket changes future purchases only; existing stock
  holdings are never sold or rebalanced.
- Source-health or freshness failure blocks only a new Registry update. It must
  not disable the keeper or stop `poke()` against the last valid basket.
- Do not distribute stock once per day. Fees accumulate continuously; the keeper
  checks hourly and advances `CoatFeeHook.flush`, `FeeSplitter.flush`, eligible
  `Booster.poke`, and threshold/TWAP-eligible buyback stages. Stock purchases credit
  `claimable(tokenId)`; the owner later claims into the Broker TBA.
- Users claim whenever they choose. Purchased stocks remain attributed through
  `claimable(tokenId)` until claimed into the Broker's ERC-6551 wallet.

This avoids meaningless daily epochs on days with no new filings, keeps active
Brokers earning from fee flow, and avoids expensive wallet-by-wallet distributions.

## Commands

```bash
cp .env.example .env
python3 run.py --out latest-basket.json          # live dry run
python3 run.py --post --out latest-basket.json   # changed baskets only
python3 keeper.py                                  # read-only staged action plan
KEEPER_PRIVATE_KEY=... python3 keeper.py --execute # flush/poke/buyback stages
KEEPER_PRIVATE_KEY=... python3 claim_distributor.py --execute --max-batches 20
python3 testnet_load.py --init                         # creates 888 secret actor keys
python3 testnet_load.py --execute --max-actions 100   # chain 46630 only, resumable
```

The bundled sample can be posted only on testnet and only with the explicit
`--allow-sample-post` flag. It exists solely for deterministic EIP-712 testing.

## Current staging state

The active chain-46630 `StrategyRegistry` is epoch 1 with AMZN/AAPL/COIN test weights
6,196/2,654/1,150 bps. The signed post, purchase and `claimBatch([487,742])` receipts are recorded
in `reports/testnet-basket-2026-08-15.json` and `../ADDRESSES.md`; each target TBA holds the three
test assets and has zero remaining claimable balance from that cycle. The sample was explicitly
allowed only for testnet and bypassed the production coverage threshold. It is lifecycle evidence,
not a production basket endorsement.

The inventory venue models ETH at exactly 2,000 USD. Its manual guard expires after 30 minutes, so
refresh that staging value before another keeper purchase. Do not use a manual fallback on mainnet
when a fresh ETH/USD feed is required.

## Go / no-go gates

GO requires: a rotated provider key, passing snapshot health, non-empty canonical
basket, expected chain/address wiring, funded relayer, successful simulation and
receipt status 1. NO-GO on any failed gate; retain the previous on-chain basket.

The indexer and keeper use separate scheduled workflows. The indexer runs every
six hours with `TESTNET_ORACLE_PRIVATE_KEY`; the keeper runs hourly with the
gas-funded, roleless `TESTNET_KEEPER_PRIVATE_KEY`. Congress API or indexer failure
therefore cannot stop purchases against the last valid basket.

The keeper is staged because fee ETH is not born in Booster: it can be buffered in
the hook and FeeSplitter first. Each stage is permissionless and independently
reported. Buyback uses a separate minimum keeper balance to avoid wasting gas on
tiny swaps; insufficient balance or TWAP history rolls forward.

The testnet reward venue is inventory-funded and transfer-only. It never mints
official stock tokens. Mainnet must use liquid DEX pools and guarded oracle quotes.
