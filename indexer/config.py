"""Coattail Brokers — off-chain indexer config.

Pulls US Congress (Senate + House) stock disclosures from Financial Modeling
Prep, aggregates net buying per ticker, keeps only tickers tokenized on
Robinhood Chain, renormalizes to bps, and posts the target basket to
StrategyRegistry.setStrategy(strategyId, tokens, weightsBps).
"""

import os
from pathlib import Path


def _load_local_env() -> None:
    """Load indexer/.env for local ops without overriding process secrets."""
    path = Path(__file__).with_name(".env")
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_local_env()

# ── FMP ─────────────────────────────────────────────────────────────────────
FMP_API_KEY = os.environ.get("FMP_API_KEY", "")
FMP_BASE = "https://financialmodelingprep.com/stable"   # legacy: .../api/v4
SENATE_ENDPOINT = "senate-latest"
HOUSE_ENDPOINT = "house-latest"
PAGE_LIMIT = 100          # rows per page
MAX_PAGES = 20            # cap pages/chamber (free tier: 250 req/day)

# ── Source selection ────────────────────────────────────────────────────────
# auto prefers Unusual Whales because it exposes a normalized Congress schema,
# then falls back to FMP. Market Tide is deliberately not used: it measures
# options sentiment, not congressional disclosures.
DATA_SOURCE = os.environ.get("INDEXER_DATA_SOURCE", "auto").lower()
UNUSUAL_WHALES_API_KEY = os.environ.get("UNUSUAL_WHALES_API_KEY", "")
UNUSUAL_WHALES_BASE = "https://api.unusualwhales.com"
UW_MAX_PAGES = int(os.environ.get("UW_MAX_PAGES", "8"))

# Refuse on-chain writes from implausibly thin/stale upstream snapshots. These
# gates are configurable, but production should not disable them.
MIN_SOURCE_ROWS = int(os.environ.get("MIN_SOURCE_ROWS", "10"))
MIN_DISTINCT_TRADERS = int(os.environ.get("MIN_DISTINCT_TRADERS", "3"))
MAX_DISCLOSURE_AGE_DAYS = int(os.environ.get("MAX_DISCLOSURE_AGE_DAYS", "60"))

# ── Aggregation ─────────────────────────────────────────────────────────────
TRAILING_DAYS = 90        # window over transactionDate (disclosures lag ~45d)
MODE = "net"              # "net" = buys minus sells; "gross" = buys only
MIN_NOTIONAL = 15_000     # ignore tickers whose net notional is below this
MAX_BASKET = 25           # cap basket size (gas + focus)
MIN_ROUTE_COVERAGE = float(os.environ.get("MIN_ROUTE_COVERAGE", "0.70"))
if not 0 <= MIN_ROUTE_COVERAGE <= 1:
    raise ValueError("MIN_ROUTE_COVERAGE must be between 0 and 1")

# ── Strategy / chain ────────────────────────────────────────────────────────
STRATEGY_ID = 0           # The Politician
BPS = 10_000

# Network selects chain id + RPC + which tokenized-stock address map to use.
NETWORK = os.environ.get("NETWORK", "mainnet")
_NET = {
    "mainnet": {"chain_id": 4663, "rpc": "https://rpc.mainnet.chain.robinhood.com"},
    "testnet": {"chain_id": 46630, "rpc": "https://rpc.testnet.chain.robinhood.com"},
}[NETWORK]

# Robinhood Chain contract wiring (env overrides win; must match the target network).
CHAIN_ID = int(os.environ.get("CHAIN_ID", _NET["chain_id"]))
RPC_URL = os.environ.get("RH_RPC_URL", _NET["rpc"])
STRATEGY_REGISTRY = os.environ.get("STRATEGY_REGISTRY_ADDRESS", "")  # 0x...
BROKER_ADDRESS = os.environ.get("BROKER_ADDRESS", "")
BOOSTER_ADDRESS = os.environ.get("BOOSTER_ADDRESS", "")
UPDATER_PRIVATE_KEY = os.environ.get("UPDATER_PRIVATE_KEY", "")      # oracle bot key = oracleSigner
KEEPER_PRIVATE_KEY = os.environ.get("KEEPER_PRIVATE_KEY", "")        # gas-funded poke relayer; no on-chain role
HOOK_ADDRESS = os.environ.get("HOOK_ADDRESS", "")
FEE_SPLITTER_ADDRESS = os.environ.get("FEE_SPLITTER_ADDRESS", "")
BUYBACK_BURNER_ADDRESS = os.environ.get("BUYBACK_BURNER_ADDRESS", "")
BUYBACK_THRESHOLD_WEI = int(os.environ.get("BUYBACK_THRESHOLD_WEI", "1000000000000000"))
