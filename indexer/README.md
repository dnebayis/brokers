# indexer/ — Coattail Brokers "The Politician" oracle

Off-chain bot that builds the **Politician** strategy's target basket from US
Congress stock disclosures and posts it to `StrategyRegistry`. Unusual Whales'
Congress endpoint is preferred; FMP remains an optional fallback.
This is the trust-critical, centralized piece of the flywheel (see WHITEPAPER §6).

```
Unusual Whales Congress disclosures (or FMP fallback)
  → parse amount ranges to a midpoint notional
  → net buying per ticker over a trailing window (buys − sells)
  → keep only tickers tokenized on Robinhood Chain (tokens.py allowlist)
  → top-N, renormalize weights to 10,000 bps
  → StrategyRegistry.setStrategy(strategyId, tokens, weightsBps)
```

## Setup

```bash
cd indexer
pip install -r requirements.txt
cp .env.example .env
# Add a newly rotated UNUSUAL_WHALES_API_KEY to indexer/.env
```

## Usage

```bash
python3 run.py --sample                 # bundled sample data, no API key — see the logic
python3 run.py                          # live from FMP
python3 run.py --out basket.json        # also write the basket
python3 run.py --post                   # post on-chain, EIP-712 signed (needs chain env below)
python3 run.py --post --role            # post via role-gated setStrategy instead of a signature
python3 keeper.py                       # read-only poke eligibility
python3 keeper.py --execute             # staged flush → poke → buyback runner
python3 claim_distributor.py             # preview next random-ID claim batch
python3 claim_distributor.py --execute --max-batches 20
python3 renderer_uploader.py --execute --max-batches 20
python3 renderer_uploader.py --verify-only
```

**Network:** set `NETWORK=testnet` (chain 46630) or `mainnet` (4663, default). This selects the
chain id, RPC, and which tokenized-stock address map to use — on testnet the basket is restricted
to the live testnet stocks (`tokens.TESTNET_ADDRESS`). Override individually with `CHAIN_ID` / `RH_RPC_URL`.

Posting env: `STRATEGY_REGISTRY_ADDRESS`, `UPDATER_PRIVATE_KEY`. `--post` **signs the basket EIP-712**
and relays it via `setStrategyWithSig`: the key must equal the on-chain `oracleSigner`
(`registry.setOracleSigner(...)`) — the signature is the authorization, so anyone can relay. Reads
`epochOf` and submits `epoch = current + 1` (monotonic ⇒ each signature is single-use). `--role` is
an ops fallback that calls `setStrategy` from a key holding `UPDATER_ROLE` (no signature).

> **Current staging evidence:** testnet registry epoch 1 contains the deterministic AMZN/AAPL/COIN
> sample basket. Its EIP-712 posting, keeper purchase and two-TBA claim receipts are recorded in
> `reports/testnet-basket-2026-08-15.json` and `../ADDRESSES.md`. The sample override used
> `MIN_ROUTE_COVERAGE=0` and is testnet-only; it must never be used for production posting. Note: the
> array commitments hash `abi.encodePacked(tokens/weightsBps)` with **elements padded to 32 bytes**
> (Solidity pads array elements — unlike standalone value types), which is what the contract expects.

## Data sources

`INDEXER_DATA_SOURCE=auto` prefers Unusual Whales when
`UNUSUAL_WHALES_API_KEY` is present and falls back to FMP. The correct Unusual
Whales endpoint is `/api/politician-portfolios/recent_trades`; `market-tide` is
options sentiment and is not an input to the Congress strategy.

Financial Modeling Prep remains supported through `FMP_API_KEY`, but the plan
must include the House/Senate disclosure endpoints. Upstream 402/403/429 errors
are fatal and are never replaced with fake live rows.

Endpoints `senate-latest` / `house-latest` return disclosure rows with
`symbol`, `transactionDate`, `type` (Purchase/Sale), `amount` (a STOCK Act range
string), and the member's name. Caveats we handle: amounts are ranges (we take
the midpoint), tickers aren't always normalized (we uppercase + allowlist-check).

## Tunables (`config.py`)

| Setting | Default | Meaning |
|---|---|---|
| `TRAILING_DAYS` | 90 | window over `transactionDate` (disclosures lag ~45d) |
| `MODE` | `net` | `net` = buys − sells; `gross` = buys only |
| `MIN_NOTIONAL` | 15,000 | drop tickers below this net notional |
| `MAX_BASKET` | 25 | cap basket size (gas + focus) |

## Production controls

- ✅ **`tokens.ADDRESS` snapshot filled** with canonical RH Chain Stock Token addresses from the
  official `/rhj/assets` registry. Run `python3 sync_tokens.py` to refresh the checked-in snapshot.
  The official documentation warns that a same-ticker/different-address token is not Robinhood's.
  V1 intentionally admits only AAPL, AMD, AMZN, COIN and CRCL after independent route probes.
  A canonical address alone never establishes a usable route; unverified assets remain excluded.
- Every run publishes **coverage %**, source health and the raw→basket mapping (transparency; see
  WHITEPAPER §6 — this is what earns the word "verifiable").
- The Registry bounds per-epoch drift; the indexer refuses thin, single-trader,
  stale, empty or malformed source snapshots.
- ✅ **EIP-712 signed posting implemented** (`setStrategyWithSig`, epoch-monotonic,
  deadline-bounded). The production signer, relayer/deployer and keeper are separate keys.
- `.github/workflows/indexer-schedule.yml` polls every six hours and posts only a
  changed canonical basket. `.github/workflows/keeper-schedule.yml` independently
  checks the full hook → splitter → Booster → buyback path every hour and runs the
  threshold-aware staged keeper, so a Congress API/indexer failure never pauses
  purchases against the last valid basket. Before `poke`
  works in production, wire the Booster's Chainlink slippage feeds
  (`setStockFeed` per token + an ETH/USD source) or set `allowUnguarded`.

The complete operating decision and GO/NO-GO gates are in `RUNBOOK.md`. Current staging has already
completed one three-asset purchase and two receipt-checked TBA claims. Before each additional test
purchase, refresh the venue's deliberately short-lived 2,000 USD/ETH manual guard; production uses
a live ETH/USD feed instead.

`claim_distributor.py` never assumes sequential mint order. It scans the bounded `1..1776`
domain, verifies `ownerOf`, selects only positive claims, sends at most five IDs per transaction
and advances its persisted cursor only after receipt status 1.

`renderer_uploader.py` uploads canonical bitmap/trait payloads in receipt-checked batches of five,
persists its cursor only after read-back verification, and can decode/validate every on-chain JSON
and SVG with `--verify-only` before `CoattailBroker.setRenderer` is called.

`testnet_load.py` is the clean-chain load manager. It creates 888 independent actor keys in a
mode-`0600`, ignored state file, then advances each actor through funding, one `mint(2)` receipt,
COAT purchase, one approval and two independent activations. It is chain-ID locked to `46630`,
never overwrites an actor-key file, checks every receipt and persists progress after each action.
Run it in bounded resumable slices; then use `claim_distributor.py` for the at-most-five-ID claim
batches into the 1,776 TBAs:

```bash
python3 testnet_load.py --init
python3 testnet_load.py --execute --max-actions 100
python3 claim_distributor.py --execute --max-batches 20
```

## Honesty

Brokers track **disclosed** (delayed) congressional positions, not real-time trades. Coverage is
limited to V1's five-token, route-ready intersection of the official Robinhood Chain registry and
the protocol's verified swap routes. The indexer drops unsupported names and renormalizes weights;
it must never fill gaps with unsupported canonical tokens or fabricated data.
