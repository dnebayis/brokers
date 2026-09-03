"""Watch Chainlink's Robinhood Chain feed directory for names the basket cannot route yet.

A name is "missed" when Congress is buying it, Robinhood has tokenized it, but the Booster
has no Chainlink feed for it (BE since launch). The feed can only be wired once Chainlink
lists it, and nobody wants to poll a JSON file by hand, so the indexer checks the directory
on every pass and shouts (log warning + ops alert) the first time a missed name appears.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request

DIRECTORY_URL = os.environ.get(
    "CHAINLINK_RH_DIRECTORY_URL",
    "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json",
)
_NAME_RE = re.compile(r"^Robinhood\s+([A-Z0-9.]+)-USD$", re.I)


def match_feeds(directory, tickers) -> dict[str, str]:
    """{ticker: proxyAddress} for every wanted ticker that has a 'Robinhood <T>-USD' feed."""
    wanted = {t.upper(): t for t in tickers}
    found: dict[str, str] = {}
    items = directory if isinstance(directory, list) else directory.get("feeds", [])
    for item in items:
        m = _NAME_RE.match(str(item.get("name", "")).strip())
        if not m:
            continue
        sym = m.group(1).upper()
        proxy = item.get("proxyAddress") or item.get("contractAddress")
        if sym in wanted and proxy:
            found[wanted[sym]] = proxy
    return found


def fetch_directory(url: str = DIRECTORY_URL, timeout: int = 20):
    req = urllib.request.Request(url, headers={"User-Agent": "coattail-indexer"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def newly_listed(tickers, fetch=fetch_directory) -> dict[str, str]:
    """Feeds now listed for `tickers`; {} on any directory failure (this is a nice-to-have)."""
    if not tickers:
        return {}
    try:
        return match_feeds(fetch(), tickers)
    except Exception:  # noqa: BLE001 - the directory is best effort, never fail the pass
        return {}
