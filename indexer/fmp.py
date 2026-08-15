"""Financial Modeling Prep client — fetch Senate + House stock disclosures."""

import time
from typing import List, Dict

import requests

from config import (
    FMP_API_KEY, FMP_BASE, SENATE_ENDPOINT, HOUSE_ENDPOINT, PAGE_LIMIT, MAX_PAGES,
)


def _fetch_pages(endpoint: str) -> List[Dict]:
    if not FMP_API_KEY:
        raise RuntimeError("FMP_API_KEY not set (export it or use --sample)")
    rows: List[Dict] = []
    for page in range(MAX_PAGES):
        url = f"{FMP_BASE}/{endpoint}"
        params = {"page": page, "limit": PAGE_LIMIT, "apikey": FMP_API_KEY}
        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        batch = resp.json()
        if not isinstance(batch, list) or not batch:
            break
        rows.extend(batch)
        if len(batch) < PAGE_LIMIT:
            break
        time.sleep(0.2)  # be gentle on the free tier
    return rows


def fetch_congress_trades() -> List[Dict]:
    """Return combined Senate + House disclosure rows (raw FMP schema)."""
    rows = _fetch_pages(SENATE_ENDPOINT) + _fetch_pages(HOUSE_ENDPOINT)
    # normalize the few fields the aggregator needs
    out = []
    for r in rows:
        sym = (r.get("symbol") or "").strip().upper()
        if not sym:
            continue
        out.append({
            "symbol": sym,
            "transactionDate": r.get("transactionDate") or r.get("disclosureDate") or "",
            "disclosureDate": r.get("disclosureDate") or "",
            "type": (r.get("type") or "").strip(),
            "amount": r.get("amount") or "",
            "who": f"{r.get('firstName','')} {r.get('lastName','')}".strip(),
            "chamber": "",
        })
    return out
