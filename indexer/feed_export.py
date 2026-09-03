"""Site feed exports: 30 days of filings and one page per member, from the same rows
the basket is built from.

The Feed tab used to show whatever the provider's first page held (about a week). These
files give the site 30 days of filings with member and ticker search, and a page per
member with their 90-day record: what they filed, how much, how fast, whether the name
is something the basket can buy, and their track-record multiplier when we have one.
Pure functions; run.py writes the JSON and the workflow publishes it to the data branch.
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, List

from aggregate import _is_buy, _is_sell, parse_amount

FEED_DAYS = 30


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")
    return s or "unknown"


def _date(v) -> str:
    return str(v or "")[:10]


def _kind(t: str) -> str:
    return "buy" if _is_buy(t) else ("sell" if _is_sell(t) else "other")


def _row(tr: Dict, buyable: set, basket: set) -> Dict:
    sym = str(tr.get("symbol", "")).upper()
    who = str(tr.get("who", "")).strip() or "Unknown member"
    traded, filed = _date(tr.get("transactionDate")), _date(tr.get("disclosureDate"))
    lag = None
    try:
        lag = (datetime.strptime(filed, "%Y-%m-%d") - datetime.strptime(traded, "%Y-%m-%d")).days
    except ValueError:
        pass
    return {
        "member": who, "slug": slugify(who), "chamber": str(tr.get("chamber", "")).lower(),
        "symbol": sym, "type": _kind(str(tr.get("type", ""))), "amount": str(tr.get("amount", "")),
        "notional": round(parse_amount(str(tr.get("amount", ""))), 2),
        "traded": traded, "filed": filed, "lagDays": lag,
        "buyable": sym in buyable, "inBasket": sym in basket,
    }


def feed_rows(trades: Iterable[Dict], buyable: Iterable[str], basket: Iterable[str],
              now: datetime | None = None, days: int = FEED_DAYS) -> List[Dict]:
    """Filings FILED in the last `days` days, newest filing first."""
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    cutoff = (now - timedelta(days=days)).date().isoformat()
    b, k = {s.upper() for s in buyable}, {s.upper() for s in basket}
    rows = [_row(t, b, k) for t in trades if _date(t.get("disclosureDate")) >= cutoff and t.get("symbol")]
    rows.sort(key=lambda r: (r["filed"], r["traded"], r["member"]), reverse=True)
    return rows


def members(trades: Iterable[Dict], buyable: Iterable[str], basket: Iterable[str],
            scores: Dict[str, Dict] | None = None, now: datetime | None = None, days: int = 90) -> List[Dict]:
    """One record per member over the basket window (trades in the last `days` days by
    transaction date, the aggregator's own cut): totals, top names, rows."""
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    cutoff = (now - timedelta(days=days)).date().isoformat()
    b, k = {s.upper() for s in buyable}, {s.upper() for s in basket}
    scores = scores or {}
    by: Dict[str, List[Dict]] = defaultdict(list)
    for t in trades:
        if not t.get("symbol") or _date(t.get("transactionDate")) < cutoff:
            continue
        r = _row(t, b, k)
        by[r["slug"]].append(r)
    out = []
    for slug, rows in by.items():
        rows.sort(key=lambda r: (r["filed"], r["traded"]), reverse=True)
        buys = [r for r in rows if r["type"] == "buy"]
        sells = [r for r in rows if r["type"] == "sell"]
        per_ticker: Dict[str, float] = defaultdict(float)
        for r in buys:
            per_ticker[r["symbol"]] += r["notional"]
        lags = [r["lagDays"] for r in rows if r["lagDays"] is not None and r["lagDays"] >= 0]
        name = rows[0]["member"]
        sc = scores.get(name.lower(), {})
        out.append({
            "slug": slug, "name": name, "chamber": rows[0]["chamber"],
            "trades": len(rows), "buys": len(buys), "sells": len(sells),
            "buyNotional": round(sum(r["notional"] for r in buys), 2),
            "sellNotional": round(sum(r["notional"] for r in sells), 2),
            "buyableShare": round(sum(r["notional"] for r in buys if r["buyable"]) / sum(r["notional"] for r in buys), 3) if buys and sum(r["notional"] for r in buys) else None,
            "medianLagDays": sorted(lags)[len(lags) // 2] if lags else None,
            "lastFiled": rows[0]["filed"], "lastTraded": max(r["traded"] for r in rows),
            "topTickers": [{"symbol": s, "notional": round(v, 2), "buyable": s in b} for s, v in sorted(per_ticker.items(), key=lambda kv: -kv[1])[:6]],
            "score": {"multiplier": sc.get("multiplier"), "avgExcess30d": sc.get("avgExcess30d"), "trades": sc.get("trades")} if sc else None,
            "rows": rows,
        })
    out.sort(key=lambda m: (-m["buyNotional"], m["name"]))
    return out
