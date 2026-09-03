"""Who is behind each basket name.

The basket is a weight per ticker; holders never see the filings that produced it.
`attribute` turns the same trade rows the aggregator uses into, per ticker, the members
whose disclosed buys carry it (count, midpoint notional, latest traded/filed dates, the
amount ranges), so the site can print "INTC: Nancy Pelosi, $1M-5M, traded May 29" next
to the weight, and the same for the names we could not buy. Pure: no I/O.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Dict, Iterable, List

from aggregate import _is_buy, _is_sell, parse_amount
from config import TRAILING_DAYS

TOP_PER_TICKER = 5


def _date(value: str) -> datetime | None:
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def attribute(trades: Iterable[Dict], tickers: Iterable[str], now: datetime | None = None,
              trailing_days: int = TRAILING_DAYS, top: int = TOP_PER_TICKER) -> Dict[str, Dict]:
    """Per ticker: {"buyers": [...top contributors...], "buyerCount": n, "sellCount": n}.

    A contributor row: member, chamber, buys, notionalUsd (sum of range midpoints),
    latestTraded, latestFiled, ranges (up to three distinct amount strings, largest first).
    Only buys inside the trailing window count, exactly like the aggregator.
    """
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    cutoff = now - timedelta(days=trailing_days)
    wanted = {str(t).upper() for t in tickers}
    per: Dict[str, Dict[str, Dict]] = {t: {} for t in wanted}
    sells: Dict[str, int] = {t: 0 for t in wanted}
    for tr in trades:
        sym = str(tr.get("symbol", "")).upper()
        if sym not in wanted:
            continue
        traded = _date(tr.get("transactionDate"))
        if traded is None or traded < cutoff:
            continue
        kind = str(tr.get("type", ""))
        if _is_sell(kind):
            sells[sym] += 1
            continue
        if not _is_buy(kind):
            continue
        who = str(tr.get("who", "")).strip() or "Unknown member"
        row = per[sym].setdefault(who, {
            "member": who,
            "chamber": str(tr.get("chamber", "")).strip().lower(),
            "buys": 0,
            "notionalUsd": 0.0,
            "latestTraded": "",
            "latestFiled": "",
            "ranges": [],
        })
        row["buys"] += 1
        row["notionalUsd"] += parse_amount(str(tr.get("amount", "")))
        row["latestTraded"] = max(row["latestTraded"], str(tr.get("transactionDate", ""))[:10])
        row["latestFiled"] = max(row["latestFiled"], str(tr.get("disclosureDate", ""))[:10])
        amount = str(tr.get("amount", "")).strip()
        if amount and amount not in row["ranges"]:
            row["ranges"].append(amount)
    out: Dict[str, Dict] = {}
    for sym in sorted(wanted):
        rows = sorted(per[sym].values(), key=lambda r: (-r["notionalUsd"], r["member"]))
        for r in rows:
            r["notionalUsd"] = round(r["notionalUsd"], 2)
            r["ranges"] = sorted(r["ranges"], key=parse_amount, reverse=True)[:3]
        out[sym] = {
            "buyers": rows[:top],
            "buyerCount": len(rows),
            "sellCount": sells[sym],
        }
    return out
