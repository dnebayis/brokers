#!/usr/bin/env python3
"""Member track-record backtest — smart-basket layer 2 (shadow-first).

Scores each Congress member by how their PAST disclosed buys performed after the
disclosure became public, so the shadow basket can overweight members whose filings
have historically carried signal. Two stages, both deterministic and reviewable:

  --fetch   pull the full disclosed-trade history from Unusual Whales into a raw JSON
            (runs where the API key lives, i.e. GitHub Actions);
  --score   value every buy against free Stooq daily closes: excess return vs SPY over
            the 30 days AFTER the disclosure date (what a copier could actually capture
            — not the member's own entry), winsorized, then shrunk toward zero by trade
            count so a lucky two-trade member cannot outrank a consistent twenty-trade
            one. Writes member-scores.json for aggregate.smart_aggregate to consume.

The output multiplier is clamped to [TRACK_MIN, TRACK_MAX] and defaults to 1.0 for
anyone unknown or below the minimum trade count — absence of history is never a
penalty, only demonstrated performance moves the needle.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import time
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

UW_BASE = "https://api.unusualwhales.com"
STOOQ = "https://stooq.com/q/d/l/?s={sym}&d1={d1}&d2={d2}&i=d"

HISTORY_DAYS = int(os.environ.get("TRACK_HISTORY_DAYS", "730"))
HORIZON_DAYS = 30
MIN_TRADES = int(os.environ.get("TRACK_MIN_TRADES", "5"))
SHRINK_K = float(os.environ.get("TRACK_SHRINK_K", "10"))
WINSOR = 0.50  # cap one trade's excess at +/-50%
TRACK_COEFF = float(os.environ.get("TRACK_COEFF", "0.05"))   # multiplier per % of shrunk excess
TRACK_MIN = float(os.environ.get("TRACK_MIN", "0.75"))
TRACK_MAX = float(os.environ.get("TRACK_MAX", "1.5"))


def _get(url: str, headers: dict | None = None, tries: int = 4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=headers or {"User-Agent": "coattail-backtest/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(3 * (attempt + 1))


def fetch(out_path: Path) -> None:
    key = os.environ.get("UNUSUAL_WHALES_API_KEY", "")
    if not key:
        raise RuntimeError("UNUSUAL_WHALES_API_KEY not set")
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    newer = (datetime.utcnow() - timedelta(days=HISTORY_DAYS)).date().isoformat()
    rows, page = [], 1
    while page <= 200:
        url = (f"{UW_BASE}/api/politician-portfolios/recent_trades"
               f"?limit=500&page={page}&transaction_newer_than={newer}")
        payload = json.loads(_get(url, headers))
        batch = payload.get("data", []) if isinstance(payload, dict) else []
        for item in batch:
            rows.append({
                "symbol": str(item.get("ticker") or "").strip().upper(),
                "who": str(item.get("name") or item.get("reporter") or "").strip(),
                "type": str(item.get("txn_type") or "").strip(),
                "transactionDate": str(item.get("transaction_date") or "")[:10],
                "disclosureDate": str(item.get("filed_at_date") or "")[:10],
                "amount": str(item.get("amounts") or ""),
            })
        print(f"page {page}: {len(batch)} rows (total {len(rows)})", flush=True)
        if len(batch) < 500:
            break
        page += 1
        time.sleep(0.5)
    out_path.write_text(json.dumps(rows))
    print(f"wrote {len(rows)} rows -> {out_path}")


def _closes(symbol: str, d1: str, d2: str, cache: dict) -> dict[str, float]:
    if symbol in cache:
        return cache[symbol]
    sym = symbol.lower().replace(".", "-") + ".us"
    try:
        raw = _get(STOOQ.format(sym=sym, d1=d1.replace("-", ""), d2=d2.replace("-", "")))
        table = {}
        for row in csv.DictReader(io.StringIO(raw.decode())):
            try:
                table[row["Date"]] = float(row["Close"])
            except (KeyError, ValueError):
                continue
        cache[symbol] = table
    except Exception:
        cache[symbol] = {}
    time.sleep(0.35)  # stay polite with the free source
    return cache[symbol]


def _window_return(closes: dict[str, float], start: str) -> float | None:
    """Return over HORIZON_DAYS starting at the first close ON/AFTER `start`."""
    if not closes:
        return None
    days = sorted(closes)
    d0 = next((d for d in days if d >= start), None)
    if d0 is None or (datetime.fromisoformat(d0) - datetime.fromisoformat(start)).days > 7:
        return None
    target = (datetime.fromisoformat(d0) + timedelta(days=HORIZON_DAYS)).date().isoformat()
    d1 = max((d for d in days if d <= target), default=None)
    if d1 is None or (datetime.fromisoformat(d1) - datetime.fromisoformat(d0)).days < HORIZON_DAYS - 10:
        return None  # window not yet complete (too recent) or data gap
    return closes[d1] / closes[d0] - 1.0


def score(raw_path: Path, out_path: Path) -> None:
    rows = json.loads(raw_path.read_text())
    buys = [r for r in rows
            if ("purchase" in r["type"].lower() or r["type"].lower() == "buy")
            and r["symbol"] and r["disclosureDate"]]
    print(f"{len(rows)} rows, {len(buys)} buys")

    d1 = min(r["disclosureDate"] for r in buys)
    d2 = datetime.utcnow().date().isoformat()
    cache: dict = {}
    spy = _closes("SPY", d1, d2, cache)
    if not spy:
        raise RuntimeError("no SPY benchmark data — refusing to score against nothing")

    per_member: dict[str, list[float]] = {}
    used = skipped = 0
    for r in buys:
        closes = _closes(r["symbol"], d1, d2, cache)
        ret = _window_return(closes, r["disclosureDate"])
        bench = _window_return(spy, r["disclosureDate"])
        if ret is None or bench is None:
            skipped += 1
            continue
        excess = max(-WINSOR, min(WINSOR, ret - bench))
        per_member.setdefault(r["who"].strip().lower(), []).append(excess)
        used += 1
    print(f"scored {used} buys, skipped {skipped} (missing/short price windows)")

    scores = {}
    for who, xs in per_member.items():
        n = len(xs)
        if n < MIN_TRADES:
            continue
        avg = sum(xs) / n
        shrunk = avg * n / (n + SHRINK_K)          # low-count members pulled toward 0
        pct = shrunk * 100.0
        mult = max(TRACK_MIN, min(TRACK_MAX, 1.0 + TRACK_COEFF * pct))
        scores[who] = {"trades": n, "avgExcess30d": round(avg, 4),
                       "shrunkPct": round(pct, 2), "multiplier": round(mult, 3)}

    out = {
        "generatedAt": datetime.utcnow().isoformat(),
        "horizonDays": HORIZON_DAYS, "historyDays": HISTORY_DAYS,
        "minTrades": MIN_TRADES, "shrinkK": SHRINK_K,
        "coeff": TRACK_COEFF, "clamp": [TRACK_MIN, TRACK_MAX],
        "buysScored": used, "buysSkipped": skipped,
        "members": scores,
    }
    out_path.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")
    ranked = sorted(scores.items(), key=lambda kv: -kv[1]["multiplier"])
    print(f"\n{len(scores)} members qualified (>= {MIN_TRADES} scored buys) -> {out_path}")
    for who, s in ranked[:10]:
        print(f"  {who:<28} x{s['multiplier']:.2f}  ({s['trades']} buys, {s['shrunkPct']:+.1f}% shrunk excess)")
    print("  ...")
    for who, s in ranked[-5:]:
        print(f"  {who:<28} x{s['multiplier']:.2f}  ({s['trades']} buys, {s['shrunkPct']:+.1f}% shrunk excess)")


def main() -> None:
    p = argparse.ArgumentParser(description="Member track-record backtest")
    p.add_argument("--fetch", action="store_true", help="pull trade history from Unusual Whales")
    p.add_argument("--score", action="store_true", help="score members from the raw history")
    p.add_argument("--raw", type=Path, default=Path("track-history.json"))
    p.add_argument("--out", type=Path, default=Path("member-scores.json"))
    args = p.parse_args()
    if args.fetch:
        fetch(args.raw)
    if args.score:
        score(args.raw, args.out)
    if not args.fetch and not args.score:
        p.error("nothing to do: pass --fetch and/or --score")


if __name__ == "__main__":
    main()
