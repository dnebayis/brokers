"""Select and normalize the configured Congress disclosure source."""

from typing import Dict, List, Tuple

from config import DATA_SOURCE, FMP_API_KEY, UNUSUAL_WHALES_API_KEY


def fetch_live() -> Tuple[str, List[Dict]]:
    source = DATA_SOURCE
    if source not in {"auto", "fmp", "unusual_whales"}:
        raise RuntimeError("INDEXER_DATA_SOURCE must be auto, fmp, or unusual_whales")

    if source in {"auto", "unusual_whales"} and UNUSUAL_WHALES_API_KEY:
        from unusual_whales import fetch_congress_trades
        return "unusual_whales", fetch_congress_trades()
    if source == "unusual_whales":
        raise RuntimeError("UNUSUAL_WHALES_API_KEY not set")

    if source in {"auto", "fmp"} and FMP_API_KEY:
        from fmp import fetch_congress_trades
        return "fmp", fetch_congress_trades()
    if source == "fmp":
        raise RuntimeError("FMP_API_KEY not set")

    raise RuntimeError(
        "No Congress data source configured. Set a rotated UNUSUAL_WHALES_API_KEY "
        "or a plan-enabled FMP_API_KEY."
    )
