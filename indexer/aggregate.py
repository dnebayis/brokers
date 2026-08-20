"""Aggregate congressional trades into a tokenizable, bps-normalized basket."""

import re
from datetime import datetime, timedelta
from typing import Iterable, List, Dict, Tuple

from config import TRAILING_DAYS, MODE, MIN_NOTIONAL, MAX_BASKET, BPS
from tokens import is_tokenized

_NUM = re.compile(r"[\d,]+")


def parse_amount(amount: str) -> float:
    """STOCK Act amount range string -> midpoint notional (USD).

    e.g. "$1,001 - $15,000" -> 8000.5 ; "$50,000,001 - $50,000,000" -> midpoint.
    Single values or unparseable -> best effort / 0.
    """
    nums = [float(m.group().replace(",", "")) for m in _NUM.finditer(amount or "")]
    if not nums:
        return 0.0
    if len(nums) == 1:
        return nums[0]
    return (nums[0] + nums[1]) / 2.0


def _is_buy(t: str) -> bool:
    return "purchase" in t.lower() or t.lower() == "buy"


def _is_sell(t: str) -> bool:
    return "sale" in t.lower() or "sell" in t.lower()


def _within_window(date_str: str, cutoff: datetime) -> bool:
    try:
        return datetime.strptime(date_str[:10], "%Y-%m-%d") >= cutoff
    except (ValueError, TypeError):
        return True  # keep undated rows rather than silently dropping


def aggregate(trades: List[Dict]) -> Dict[str, float]:
    """Net (or gross) notional per ticker over the trailing window."""
    cutoff = datetime.utcnow() - timedelta(days=TRAILING_DAYS)
    net: Dict[str, float] = {}
    for tr in trades:
        if not _within_window(tr.get("transactionDate", ""), cutoff):
            continue
        amt = parse_amount(tr.get("amount", ""))
        if amt <= 0:
            continue
        sym = tr["symbol"]
        if _is_buy(tr["type"]):
            net[sym] = net.get(sym, 0.0) + amt
        elif _is_sell(tr["type"]) and MODE == "net":
            net[sym] = net.get(sym, 0.0) - amt
    return net


def to_basket(net: Dict[str, float]) -> List[Tuple[str, int]]:
    """Filter to tokenizable, positive, above-floor; take top-N; -> [(ticker, bps)]."""
    eligible = {
        s: v for s, v in net.items()
        if v >= MIN_NOTIONAL and is_tokenized(s)
    }
    if not eligible:
        return []
    top = sorted(eligible.items(), key=lambda kv: kv[1], reverse=True)[:MAX_BASKET]
    total = sum(v for _, v in top)

    # proportional bps, then fix rounding so the sum is exactly BPS
    basket = [(s, int(v / total * BPS)) for s, v in top]
    drift = BPS - sum(w for _, w in basket)
    if basket:
        s0, w0 = basket[0]
        basket[0] = (s0, w0 + drift)  # dump rounding remainder on the largest
    return basket


def coverage(net: Dict[str, float], exclude: Iterable[str] = ()) -> float:
    """Fraction of positive net notional that is tokenizable on RH Chain.

    `exclude` drops tickers from the tokenizable side without changing the denominator —
    used to report honest coverage after the live route pre-flight removes a leg whose
    pool cannot fill today.
    """
    skip = set(exclude)
    pos = {s: v for s, v in net.items() if v > 0}
    total = sum(pos.values()) or 1.0
    tokenizable = sum(v for s, v in pos.items() if is_tokenized(s) and s not in skip)
    return tokenizable / total
