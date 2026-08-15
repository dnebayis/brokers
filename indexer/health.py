"""Fail-closed health checks for snapshots that may be posted on-chain."""

from datetime import datetime, timezone
from typing import Dict, List

from config import MAX_DISCLOSURE_AGE_DAYS, MIN_DISTINCT_TRADERS, MIN_SOURCE_ROWS


def snapshot_health(trades: List[Dict]) -> Dict:
    names = {str(row.get("who") or "").strip() for row in trades}
    names.discard("")
    dates = []
    for row in trades:
        value = str(row.get("disclosureDate") or row.get("transactionDate") or "")[:10]
        try:
            dates.append(datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc))
        except ValueError:
            pass
    latest = max(dates) if dates else None
    age_days = (datetime.now(timezone.utc) - latest).days if latest else None
    errors = []
    if len(trades) < MIN_SOURCE_ROWS:
        errors.append(f"only {len(trades)} rows (minimum {MIN_SOURCE_ROWS})")
    if len(names) < MIN_DISTINCT_TRADERS:
        errors.append(f"only {len(names)} distinct traders (minimum {MIN_DISTINCT_TRADERS})")
    if age_days is None:
        errors.append("no parseable disclosure/transaction date")
    elif age_days > MAX_DISCLOSURE_AGE_DAYS:
        errors.append(f"latest disclosure is {age_days} days old (maximum {MAX_DISCLOSURE_AGE_DAYS})")
    return {
        "ok": not errors,
        "rows": len(trades),
        "distinctTraders": len(names),
        "latestDisclosure": latest.date().isoformat() if latest else None,
        "ageDays": age_days,
        "errors": errors,
    }
