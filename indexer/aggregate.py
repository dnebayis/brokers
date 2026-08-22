"""Aggregate congressional trades into a tokenizable, bps-normalized basket."""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Iterable, List, Dict, Tuple

from config import (
    TRAILING_DAYS, MODE, MIN_NOTIONAL, MAX_BASKET, MAX_WEIGHT_BPS, BPS,
    CONVICTION_COEFF, CONVICTION_MAX,
    DECAY_HALF_LIFE_DAYS, FAST_FILER_BONUS, FAST_FILER_DAYS, SELL_VETO_RATIO,
)
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


def _parse_date(date_str: str) -> datetime | None:
    try:
        return datetime.strptime(str(date_str)[:10], "%Y-%m-%d")
    except (ValueError, TypeError):
        return None


def smart_row_multiplier(tr: Dict, now: datetime) -> float:
    """Freshness weight for one disclosure row: decay x fast-filer bonus.

    Decay anchors on the DISCLOSURE date — the moment the information became public and
    started getting priced in — falling back to the transaction date when the filing
    date is missing. The fast-filer bonus rewards short transaction->filing lag (fresh
    information), fading linearly to nothing at FAST_FILER_DAYS. Rows with no parseable
    dates keep weight 1.0 rather than being silently dropped, matching _within_window.
    """
    disclosed = _parse_date(tr.get("disclosureDate", ""))
    transacted = _parse_date(tr.get("transactionDate", ""))
    anchor = disclosed or transacted

    decay = 1.0
    if DECAY_HALF_LIFE_DAYS > 0 and anchor is not None:
        age_days = max((now - anchor).total_seconds() / 86400.0, 0.0)
        decay = 0.5 ** (age_days / DECAY_HALF_LIFE_DAYS)

    filer = 1.0
    if FAST_FILER_BONUS > 0 and disclosed is not None and transacted is not None:
        lag_days = max((disclosed - transacted).total_seconds() / 86400.0, 0.0)
        filer = 1.0 + FAST_FILER_BONUS * max(0.0, 1.0 - lag_days / FAST_FILER_DAYS)

    return decay * filer


def smart_aggregate(trades: List[Dict], now: datetime | None = None) -> Tuple[Dict[str, float], set]:
    """Freshness-weighted net notional per ticker, plus the sell-vetoed set.

    Same shape as `aggregate` but every row's midpoint is scaled by
    `smart_row_multiplier` (both sides — a fresh, fast-filed sell is information too).
    A ticker whose weighted gross selling reaches SELL_VETO_RATIO x its weighted gross
    buying lands in the veto set: the caller must exclude it from the basket even if its
    net is still positive, because the only lever this system has is to stop routing
    NEW money at a name Congress is exiting.
    """
    now = now or datetime.utcnow()
    cutoff = now - timedelta(days=TRAILING_DAYS)
    net: Dict[str, float] = {}
    gross_buy: Dict[str, float] = {}
    gross_sell: Dict[str, float] = {}
    for tr in trades:
        if not _within_window(tr.get("transactionDate", ""), cutoff):
            continue
        amt = parse_amount(tr.get("amount", ""))
        if amt <= 0:
            continue
        weighted = amt * smart_row_multiplier(tr, now)
        sym = tr["symbol"]
        if _is_buy(tr["type"]):
            net[sym] = net.get(sym, 0.0) + weighted
            gross_buy[sym] = gross_buy.get(sym, 0.0) + weighted
        elif _is_sell(tr["type"]):
            gross_sell[sym] = gross_sell.get(sym, 0.0) + weighted
            if MODE == "net":
                net[sym] = net.get(sym, 0.0) - weighted

    vetoed = set()
    if SELL_VETO_RATIO > 0:
        for sym, sells in gross_sell.items():
            buys = gross_buy.get(sym, 0.0)
            if sells >= SELL_VETO_RATIO * buys:
                vetoed.add(sym)
    return net, vetoed


def cap_weights(values: List[float], cap_bps: int) -> List[int]:
    """Allocate exactly BPS across `values` (proportional to each), with no single entry
    above `cap_bps`. Water-fill: pin whatever exceeds the cap at the cap, then re-split the
    remaining budget across the rest by signal, repeating until nothing else overflows.

    STOCK Act discloses dollar *ranges*, so one large disclosure priced at its midpoint can
    otherwise swamp the basket; this bounds any one name without discarding the signal —
    the excess flows to the next names by size, not evenly.
    """
    n = len(values)
    if n == 0:
        return []
    # If the cap is too tight to even fit n names, fall back to an even split at the cap.
    cap = max(cap_bps, -(-BPS // n))  # ceil(BPS/n)
    capped = [False] * n
    alloc = [0.0] * n
    remaining = float(BPS)
    while True:
        pool = [i for i in range(n) if not capped[i]]
        pool_sum = sum(values[i] for i in pool)
        if not pool:
            break
        if pool_sum <= 0:
            share = remaining / len(pool)
            for i in pool:
                alloc[i] = share
            break
        overflow = [i for i in pool if values[i] / pool_sum * remaining > cap + 1e-9]
        if overflow:
            for i in overflow:
                alloc[i] = cap
                capped[i] = True
            remaining = BPS - sum(alloc[i] for i in range(n) if capped[i])
            continue
        for i in pool:
            alloc[i] = values[i] / pool_sum * remaining
        break

    # Integer bps via largest-remainder, never lifting an entry above the cap.
    weights = [int(a) for a in alloc]
    drift = BPS - sum(weights)
    order = sorted(range(n), key=lambda i: alloc[i] - weights[i], reverse=True)
    while drift > 0:
        progressed = False
        for i in order:
            if drift == 0:
                break
            if weights[i] < cap:
                weights[i] += 1
                drift -= 1
                progressed = True
        if not progressed:  # everything at the cap (defensive; cap*n >= BPS guarantees room)
            break
    return weights


def to_basket(net: Dict[str, float], buyers: Dict[str, int] | None = None) -> List[Tuple[str, int]]:
    """Filter to tokenizable, positive, above-floor; take top-N; -> [(ticker, bps)].

    A name still needs real dollars (>= MIN_NOTIONAL) to qualify, but among the qualifiers
    the ranking and weights use the CONVICTION-weighted value (dollars x how many distinct
    members bought it), so broadly-supported names lead. Pass buyers=None for pure dollar
    weighting (the pre-conviction behaviour).
    """
    buyers = buyers or {}
    eligible = {
        s: v * conviction_multiplier(buyers.get(s, 1))
        for s, v in net.items()
        if v >= MIN_NOTIONAL and is_tokenized(s)
    }
    if not eligible:
        return []
    top = sorted(eligible.items(), key=lambda kv: kv[1], reverse=True)[:MAX_BASKET]
    weights = cap_weights([v for _, v in top], MAX_WEIGHT_BPS)
    return [(s, w) for (s, _), w in zip(top, weights)]


def buyer_counts(trades: List[Dict]) -> Dict[str, int]:
    """Distinct members who *bought* each ticker in the trailing window.

    This is the conviction signal: a name five members are accumulating is a stronger
    read than the same dollars from one wallet. Sells are ignored here — a member exiting
    doesn't remove another member's conviction; the dollar `aggregate` already nets those.
    """
    cutoff = datetime.utcnow() - timedelta(days=TRAILING_DAYS)
    buyers: Dict[str, set] = {}
    for tr in trades:
        if not _within_window(tr.get("transactionDate", ""), cutoff):
            continue
        if not _is_buy(tr.get("type", "")):
            continue
        if parse_amount(tr.get("amount", "")) <= 0:
            continue
        who = str(tr.get("who", "")).strip().lower()
        if not who:
            continue
        buyers.setdefault(tr["symbol"], set()).add(who)
    return {sym: len(members) for sym, members in buyers.items()}


def conviction_multiplier(distinct_buyers: int) -> float:
    """1 buyer -> 1.0x, each additional distinct member adds COEFF, capped at MAX."""
    if distinct_buyers <= 1:
        return 1.0
    return min(1.0 + CONVICTION_COEFF * (distinct_buyers - 1), CONVICTION_MAX)


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
