"""Unusual Whales Congress disclosure client.

Uses politician-portfolios/recent_trades rather than market-tide. Market Tide
is an options-flow sentiment series and cannot build the Politician basket.
"""

import os
import time
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


# Transient upstream faults are not answers about the data: a stray 503 used to abort the
# whole scheduled run and leave the basket un-refreshed for six hours (observed 2026-08-20).
# Retrying with backoff turns nearly all of them into a normal run; a non-429 4xx is a real
# answer (bad key/params) and is never retried.
RETRY_STATUSES = {429, 500, 502, 503, 504}
FETCH_ATTEMPTS = int(os.environ.get("UW_FETCH_ATTEMPTS", "4"))


def _retry_delay(exc: Exception, attempt: int) -> float:
    """Retry-After when the server says so (a 429 window is ~60s, far past 1-2-4s),
    otherwise exponential backoff."""
    response = getattr(exc, "response", None)
    header = getattr(response, "headers", {}).get("Retry-After") if response is not None else None
    if header:
        try:
            return min(max(float(header), 1.0), 120.0)
        except (TypeError, ValueError):
            pass
    return float(2 ** attempt)


def _get_with_retry(url: str, headers: Dict, params: Dict) -> requests.Response:
    last_error: Exception | None = None
    attempts = max(FETCH_ATTEMPTS, 1)
    for attempt in range(attempts):
        try:
            response = requests.get(url, headers=headers, params=params, timeout=30)
            if response.status_code in RETRY_STATUSES:
                raise requests.exceptions.HTTPError(
                    f"{response.status_code} {response.reason} for url: {response.url}",
                    response=response,
                )
            response.raise_for_status()
            return response
        except (requests.exceptions.HTTPError,
                requests.exceptions.ConnectionError,
                requests.exceptions.Timeout) as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status is not None and status not in RETRY_STATUSES:
                raise
            last_error = exc
            if attempt < attempts - 1:
                time.sleep(_retry_delay(exc, attempt))
    raise RuntimeError(f"Unusual Whales unavailable after {attempts} attempts: {last_error}")


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
    # Two cutoffs. The FILED cutoff (TRAILING_DAYS) ends the page walk, because the feed is
    # ordered by filing. The TRANSACTION cutoff sent to the API is wider (UW_TXN_LOOKBACK_DAYS,
    # default 150): a filing made inside the window can describe a trade from before it
    # (members file up to 45 days late, some later), and the old single cutoff dropped those
    # rows at the source. The live aggregate still keys on the transaction date and its own
    # 90-day window, so nothing changes on chain; the extra rows feed the filed-window shadow.
    newer_than = (datetime.now(timezone.utc) - timedelta(days=TRAILING_DAYS)).date().isoformat()
    txn_newer_than = (datetime.now(timezone.utc)
                      - timedelta(days=int(os.environ.get("UW_TXN_LOOKBACK_DAYS", "150")))).date().isoformat()
    rows: List[Dict] = []
    batch: List = []
    # Every raw row is deduplicated on its full identity, and a page whose content
    # repeats the previous page stops the walk: raising the page cap 8->16->40 kept
    # every page full (kept-per-page constant ~330-390), which is the signature of
    # deep-pagination wraparound/duplication rather than organic data. Exact duplicate
    # rows are artifacts either way — counting one disclosure N times multiplies its
    # dollars N times and silently distorts the basket.
    seen: set = set()
    duplicates = 0
    prev_page_sig = None
    repeat_detected = False
    old_filed_pages = 0
    for page in range(1, UW_MAX_PAGES + 1):
        response = _get_with_retry(url, headers, {
            "limit": 500,
            "page": page,
            "transaction_newer_than": txn_newer_than,
        })
        payload = response.json()
        batch = payload.get("data", []) if isinstance(payload, dict) else []
        if not isinstance(batch, list):
            raise RuntimeError("Unusual Whales returned an unexpected response shape")
        page_sig = tuple(
            (str(x.get("name")), str(x.get("ticker")), str(x.get("transaction_date")))
            for x in batch[:5]
        )
        if batch and page_sig == prev_page_sig:
            repeat_detected = True
            break
        prev_page_sig = page_sig
        # Early stop, keyed on FILED date, never transaction date: the feed is ordered
        # by filing, and late filers scatter old transaction dates through early pages
        # (a transaction-date stop once cut the walk at page 3 and dropped 95% of the
        # window). A transaction inside the window must be FILED inside the window
        # (nobody files before trading), so pages whose filings all predate the cutoff
        # cannot contain in-window rows. Two consecutive such pages end the walk —
        # the second page guards against any local ordering wobble.
        page_filed = [_date(x.get("filed_at_date")) for x in batch]
        page_filed = [d for d in page_filed if d]
        if page_filed and max(page_filed) < newer_than:
            old_filed_pages += 1
            if old_filed_pages >= 2:
                print(f"UW window exhausted at page {page} (newest filing {max(page_filed)} "
                      f"< cutoff {newer_than}, second consecutive pre-window page); stopping early")
                break
        else:
            old_filed_pages = 0
        # Two distinct filings can be identical in every field we keep: a member reporting
        # the same ticker, day and dollar range for their own account and for a spouse's.
        # Collapsing those halved their dollars. So the key carries how many times this
        # identity has already appeared IN THIS PAGE (repeats inside one response are
        # separate records) while a page that repeats an earlier page still produces the
        # same keys and is collapsed. Any identity-bearing field the API exposes joins the
        # key too, so the day one appears the rows separate on their own.
        page_seen: Dict[tuple, int] = {}
        for item in batch:
            symbol = str(item.get("ticker") or "").strip().upper()
            if not symbol:
                continue
            row = {
                "symbol": symbol,
                "transactionDate": _date(item.get("transaction_date")),
                "disclosureDate": _date(item.get("filed_at_date")),
                "type": str(item.get("txn_type") or "").strip(),
                "amount": str(item.get("amounts") or ""),
                "who": str(item.get("name") or item.get("reporter") or "").strip(),
                "chamber": str(item.get("member_type") or "").strip().lower(),
            }
            identity = tuple(sorted(row.items())) + tuple(
                (k, str(item.get(k)))
                for k in ("owner", "id", "transaction_id", "filing_id", "asset_description")
                if item.get(k) is not None
            )
            occurrence = page_seen.get(identity, 0)
            page_seen[identity] = occurrence + 1
            key = identity + (("_occurrence", occurrence),)
            if key in seen:
                duplicates += 1
                continue
            seen.add(key)
            rows.append(row)
        if len(batch) < 500:
            break
    else:
        # The loop exhausted UW_MAX_PAGES with the last page still full AND unique:
        # the window genuinely holds more rows than the cap and the OLDEST disclosures
        # were dropped. That skews the basket without any error, so make it loud.
        if len(batch) == 500:
            from ops_alerts import alert
            message = (f"Unusual Whales page cap hit: {UW_MAX_PAGES} pages x 500 rows all full "
                       f"({duplicates} duplicates already removed) — oldest disclosures in the "
                       f"window are being dropped; raise UW_MAX_PAGES")
            print(f"::warning::{message}")
            alert(f"⚠️ indexer: {message}")
    if repeat_detected:
        print(f"UW pagination repeat detected — stopped early; this is an upstream quirk, "
              f"data below the repeat point is intact")
    if duplicates:
        print(f"UW dedupe: dropped {duplicates} exact-duplicate rows, kept {len(rows)} unique")
    return rows
