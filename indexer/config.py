"""Coattail Brokers — off-chain indexer config.

Pulls US Congress (Senate + House) stock disclosures from Financial Modeling
Prep, aggregates net buying per ticker, keeps only tickers tokenized on
Robinhood Chain, renormalizes to bps, and posts the target basket to
StrategyRegistry.setStrategy(strategyId, tokens, weightsBps).
"""

from __future__ import annotations

import json
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
# 40 pages x 500 = 20,000 RAW rows of headroom. The first loud-cap run (2026-08-24)
# revealed the window genuinely holds >8,000 raw rows (~64% carry a ticker and are
# kept), which means the original 8-page cap had been silently truncating the oldest
# disclosures the whole time. fetch_congress_trades still warns if even 40 fills up.
UW_MAX_PAGES = int(os.environ.get("UW_MAX_PAGES", "40"))

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
# Per-name weight ceiling, in bps. STOCK Act discloses dollar ranges, so one large
# disclosure (weighted at its range midpoint) can otherwise dominate the whole basket —
# a single $1M–$5M buy dwarfs hundreds of $1K–$50K ones. This caps any single name and
# water-fills the excess into the rest by signal. BPS (10000) disables it.
MAX_WEIGHT_BPS = int(os.environ.get("MAX_WEIGHT_BPS", "5000"))
if not 0 < MAX_WEIGHT_BPS <= 10_000:
    raise ValueError("MAX_WEIGHT_BPS must be between 1 and 10000")
MIN_ROUTE_COVERAGE = float(os.environ.get("MIN_ROUTE_COVERAGE", "0.70"))
if not 0 <= MIN_ROUTE_COVERAGE <= 1:
    raise ValueError("MIN_ROUTE_COVERAGE must be between 0 and 1")

# ── Signal quality (conviction) ─────────────────────────────────────────────
# Dollar size alone is a noisy signal: a single member's large disclosure can look more
# important than a name half of Congress is quietly accumulating. We tilt the basket by
# CONVICTION — how many *distinct* members bought the name — so breadth of support counts,
# not just the loudest wallet. A name still needs real dollars (MIN_NOTIONAL) to qualify;
# conviction only re-weights among the qualifiers. multiplier = 1 + COEFF*(buyers-1),
# capped at MAX. COEFF=0 disables it (pure dollar weighting).
CONVICTION_COEFF = float(os.environ.get("CONVICTION_COEFF", "0.5"))
CONVICTION_MAX = float(os.environ.get("CONVICTION_MAX", "3.0"))
if CONVICTION_COEFF < 0 or CONVICTION_MAX < 1:
    raise ValueError("CONVICTION_COEFF must be >= 0 and CONVICTION_MAX >= 1")

# ── Signal quality (smart layer, shadow-first) ──────────────────────────────
# Three deterministic refinements on top of the conviction basket, run in SHADOW by
# default: every run computes and logs the smart basket next to the live one WITHOUT
# posting it, so we can measure the divergence for weeks before flipping. Set
# SMART_BASKET=live to post the smart weights, off to skip the computation entirely.
#   decay      — a disclosure loses weight as it ages (half-life; markets price news in);
#   fast filer — a member who files within days carries fresher information than one who
#                waits out the 45-day limit: bonus fades linearly to zero at FILER_DAYS;
#   sell veto  — when disclosed selling rivals the buying in a name, stop routing NEW
#                money to it even while net dollars are still positive (we can only ever
#                stop buying — the Booster has no sell path by design).
SMART_BASKET = os.environ.get("SMART_BASKET", "shadow")
if SMART_BASKET not in {"shadow", "live", "off"}:
    raise ValueError("SMART_BASKET must be shadow, live, or off")
DECAY_HALF_LIFE_DAYS = float(os.environ.get("DECAY_HALF_LIFE_DAYS", "14"))  # 0 disables
FAST_FILER_BONUS = float(os.environ.get("FAST_FILER_BONUS", "0.25"))        # 0 disables
FAST_FILER_DAYS = float(os.environ.get("FAST_FILER_DAYS", "14"))
SELL_VETO_RATIO = float(os.environ.get("SELL_VETO_RATIO", "1.0"))           # 0 disables
if DECAY_HALF_LIFE_DAYS < 0 or FAST_FILER_BONUS < 0 or FAST_FILER_DAYS <= 0 or SELL_VETO_RATIO < 0:
    raise ValueError("smart-basket knobs: half-life/bonus/veto >= 0 and FAST_FILER_DAYS > 0")

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

# Robinhood Chain's public RPC sits behind Cloudflare, which 403s the default
# python User-Agent (error 1010). Every on-chain script builds its provider here
# so a browser UA and sane timeout are applied uniformly, and so the automation
# works against the public RPC as well as a private endpoint.
RPC_HEADERS = {"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"}

# A domain-allowlisted provider (e.g. the mainnet Alchemy endpoint restricted to
# coattail.cash) rejects server-side requests unless they carry a matching Origin.
# Set RH_RPC_ORIGIN=https://www.coattail.cash for the mainnet indexer/keeper.
RPC_ORIGIN = os.environ.get("RH_RPC_ORIGIN", "")
if RPC_ORIGIN:
    RPC_HEADERS["Origin"] = RPC_ORIGIN


# The public RH endpoint for this network, used as a last-resort fallback when the
# configured RH_RPC_URL is a private/allowlisted provider that is momentarily down.
PUBLIC_RPC_URL = _NET["rpc"]

RPC_CONNECT_ATTEMPTS = int(os.environ.get("RPC_CONNECT_ATTEMPTS", "4"))


def _try_connect(rpc_url: str, expect_chain: int | None):
    """Return a verified Web3 for `rpc_url`, or None if it is unusable right now."""
    from web3 import Web3

    try:
        w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"headers": RPC_HEADERS, "timeout": 60}))
        if not w3.is_connected():
            return None
        if expect_chain is not None and w3.eth.chain_id != expect_chain:
            # A wrong chain is a configuration error, never a transient one: fail loudly
            # rather than silently retrying or falling back onto the wrong network.
            raise RuntimeError(f"RPC chain {w3.eth.chain_id} != expected {expect_chain}")
        return w3
    except RuntimeError:
        raise
    except Exception:
        return None


def make_web3(rpc_url: str = RPC_URL, expect_chain: int | None = CHAIN_ID):
    """Return a connected Web3 for `rpc_url`, verifying the chain id when given.

    A single failed connect used to abort the whole run — two scheduled keeper runs died
    one second in with "RPC unavailable" while the chain itself was healthy, skipping an
    hour of flushes/pokes for nothing. Retry with backoff, then fall back to this network's
    public endpoint, so a blip at one provider can no longer strand a run. The chain-id
    check still guards the fallback, so it can never talk to the wrong network.
    """
    import time

    attempts = max(RPC_CONNECT_ATTEMPTS, 1)
    for attempt in range(attempts):
        w3 = _try_connect(rpc_url, expect_chain)
        if w3 is not None:
            return w3
        if attempt < attempts - 1:
            time.sleep(2 ** attempt)

    if rpc_url != PUBLIC_RPC_URL:
        w3 = _try_connect(PUBLIC_RPC_URL, expect_chain)
        if w3 is not None:
            print(json.dumps({"rpc": "fallback", "url": PUBLIC_RPC_URL}))
            return w3

    raise RuntimeError(f"RPC unavailable after {attempts} attempts: {rpc_url}")
STRATEGY_REGISTRY = os.environ.get("STRATEGY_REGISTRY_ADDRESS", "")  # 0x...
BROKER_ADDRESS = os.environ.get("BROKER_ADDRESS", "")
# Block the Broker was deployed at — bounds Transfer-log scans (mint discovery).
BROKER_DEPLOYMENT_BLOCK = int(os.environ.get(
    "BROKER_DEPLOYMENT_BLOCK", "101454451" if NETWORK == "testnet" else "0"))
BOOSTER_ADDRESS = os.environ.get("BOOSTER_ADDRESS", "")
# Ownerless periphery that loops Booster.claimFor — lets distribution push 40 NFTs per tx
# instead of claimBatch's hard MAX of 5. Unset -> distributor falls back to claimBatch(5).
CLAIM_SWEEPER_ADDRESS = os.environ.get("CLAIM_SWEEPER_ADDRESS", "")
UPDATER_PRIVATE_KEY = os.environ.get("UPDATER_PRIVATE_KEY", "")      # oracle bot key = oracleSigner
KEEPER_PRIVATE_KEY = os.environ.get("KEEPER_PRIVATE_KEY", "")        # gas-funded poke relayer; no on-chain role
HOOK_ADDRESS = os.environ.get("HOOK_ADDRESS", "")
FEE_SPLITTER_ADDRESS = os.environ.get("FEE_SPLITTER_ADDRESS", "")
BUYBACK_BURNER_ADDRESS = os.environ.get("BUYBACK_BURNER_ADDRESS", "")
def wei_env(name: str, default: str) -> int:
    """Parse a wei env value exactly, tolerating scientific notation like '1E+15'
    that a YAML host can produce from a large unquoted integer. Decimal keeps full
    precision where int(float(...)) would round values above 2**53."""
    from decimal import Decimal

    return int(Decimal(os.environ.get(name, default)))


BUYBACK_THRESHOLD_WEI = wei_env("BUYBACK_THRESHOLD_WEI", "1000000000000000")
