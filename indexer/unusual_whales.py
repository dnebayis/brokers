"""Unusual Whales Congress disclosure client.

Uses politician-portfolios/recent_trades rather than market-tide. Market Tide
is an options-flow sentiment series and cannot build the Politician basket.
"""

from datetime import datetime, timedelta, timezone
from typing import Dict, List

import requests

from config import (
    TRAILING_DAYS,
    UNUSUAL_WHALES_API_KEY,
    UNUSUAL_WHALES_BASE,
    UW_MAX_PAGES,
)


def _date(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc).date().isoformat()
    text = str(value)
    return text[:10] if len(text) >= 10 else text


def fetch_congress_trades() -> List[Dict]:
    if not UNUSUAL_WHALES_API_KEY:
        raise RuntimeError("UNUSUAL_WHALES_API_KEY not set")

    url = f"{UNUSUAL_WHALES_BASE}/api/politician-portfolios/recent_trades"
    headers = {
        "Authorization": f"Bearer {UNUSUAL_WHALES_API_KEY}",
        "Accept": "application/json",
    }
    # The API validates transaction_newer_than as a YYYY-MM-DD date, not a unix
    # timestamp (a timestamp returns 422 Unprocessable Entity).
    newer_than = (datetime.now(timezone.utc) - timedelta(days=TRAILING_DAYS)).date().isoformat()
    rows: List[Dict] = []
    for page in range(1, UW_MAX_PAGES + 1):
        response = requests.get(
            url,
            headers=headers,
            params={
                "limit": 500,
                "page": page,
                "transaction_newer_than": newer_than,
            },
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        batch = payload.get("data", []) if isinstance(payload, dict) else []
        if not isinstance(batch, list):
            raise RuntimeError("Unusual Whales returned an unexpected response shape")
        for item in batch:
            symbol = str(item.get("ticker") or "").strip().upper()
            if not symbol:
                continue
            rows.append({
                "symbol": symbol,
                "transactionDate": _date(item.get("transaction_date")),
                "disclosureDate": _date(item.get("filed_at_date")),
                "type": str(item.get("txn_type") or "").strip(),
                "amount": str(item.get("amounts") or ""),
                "who": str(item.get("name") or item.get("reporter") or "").strip(),
                "chamber": str(item.get("member_type") or "").strip().lower(),
            })
        if len(batch) < 500:
            break
    return rows
