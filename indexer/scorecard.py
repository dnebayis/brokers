"""Basket scorecard: what the engine bought, at what cost, and where it trades now.

Every Booster purchase is a `Bought(token, ethIn, tokenOut)` event. This module prices
each purchase in USD with the Chainlink ETH/USD round nearest its block time (the feed
keeps its round history on chain, so no archive node is needed), aggregates per stock
(shares bought, dollars spent, average cost) and marks the position at the stock's live
Chainlink price. The result is the honest answer to "which basket names made or lost
money for holders": engine cost versus today's feed, assuming the shares are still held.
Incremental: the published scorecard carries every priced purchase, so a pass only
fetches events newer than the last one it saw.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Dict, List, Optional

WEI = 10**18
STATE_VERSION = 1


def _topic(w3) -> str:
    return "0x" + w3.keccak(text="Bought(address,uint256,uint256)").hex().replace("0x", "")


FEED_ABI = [
    {"type": "function", "name": "latestRoundData", "stateMutability": "view", "inputs": [], "outputs": [
        {"type": "uint80"}, {"type": "int256"}, {"type": "uint256"}, {"type": "uint256"}, {"type": "uint80"}]},
    {"type": "function", "name": "getRoundData", "stateMutability": "view", "inputs": [{"type": "uint80"}], "outputs": [
        {"type": "uint80"}, {"type": "int256"}, {"type": "uint256"}, {"type": "uint256"}, {"type": "uint80"}]},
    {"type": "function", "name": "decimals", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint8"}]},
]
BOOSTER_ABI = [
    {"type": "function", "name": "ethUsdFeed", "stateMutability": "view", "inputs": [], "outputs": [{"type": "address"}]},
    {"type": "function", "name": "stockFeed", "stateMutability": "view", "inputs": [{"type": "address"}], "outputs": [{"type": "address"}]},
]
TOKEN_ABI = [
    {"type": "function", "name": "symbol", "stateMutability": "view", "inputs": [], "outputs": [{"type": "string"}]},
    {"type": "function", "name": "decimals", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint8"}]},
    {"type": "function", "name": "uiMultiplier", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint256"}]},
]


class RoundIndex:
    """Nearest-round lookup on a Chainlink aggregator proxy, by timestamp, within the
    current phase. Rounds are monotonic in time, so a binary search over round ids finds
    the last update at or before a given time; results are memoised per call site."""

    def __init__(self, feed):
        self.feed = feed
        latest = feed.functions.latestRoundData().call()
        self.latest_id = int(latest[0])
        self.phase = self.latest_id >> 64
        self.latest_agg = self.latest_id & ((1 << 64) - 1)
        self.dec = int(feed.functions.decimals().call())
        self._cache: Dict[int, tuple] = {}
        # find the oldest readable round of this phase (getRoundData reverts before it)
        lo, hi = 1, self.latest_agg
        while lo < hi:
            mid = (lo + hi) // 2
            if self._round(mid) is None:
                lo = mid + 1
            else:
                hi = mid
        self.oldest_agg = lo

    def _round(self, agg: int):
        if agg in self._cache:
            return self._cache[agg]
        try:
            r = self.feed.functions.getRoundData((self.phase << 64) | agg).call()
            out = (int(r[1]), int(r[3]))
        except Exception:
            out = None
        self._cache[agg] = out
        return out

    def price_at(self, ts: int) -> Optional[float]:
        lo, hi = self.oldest_agg, self.latest_agg
        first = self._round(lo)
        if first is None or first[1] > ts:
            return None  # before the feed's readable history
        while lo < hi:
            mid = (lo + hi + 1) // 2
            r = self._round(mid)
            if r is not None and r[1] <= ts:
                lo = mid
            else:
                hi = mid - 1
        r = self._round(lo)
        return r[0] / 10 ** self.dec if r else None


def aggregate(events: List[Dict], prices: Dict[str, float], meta: Dict[str, Dict]) -> Dict:
    """Pure: per-token cost basis vs live price. `events` rows carry token, sharesRaw
    (display shares x 1e18, uiMultiplier applied), usdIn (float, may be None if unpriced)."""
    per: Dict[str, Dict] = {}
    for e in events:
        t = e["token"].lower()
        row = per.setdefault(t, {"token": e["token"], "buys": 0, "shares": 0.0, "usdSpent": 0.0, "unpriced": 0,
                                 "firstBuy": e["ts"], "lastBuy": e["ts"]})
        row["buys"] += 1
        row["shares"] += e["sharesRaw"] / WEI
        if e.get("usdIn") is None:
            row["unpriced"] += 1
        else:
            row["usdSpent"] += e["usdIn"]
        row["firstBuy"] = min(row["firstBuy"], e["ts"])
        row["lastBuy"] = max(row["lastBuy"], e["ts"])
    names = []
    tot_spent = tot_value = 0.0
    for t, row in per.items():
        px = prices.get(t)
        m = meta.get(t, {})
        shares = row["shares"]
        # cost basis counts only priced purchases; shares from unpriced ones are excluded from the
        # average so a missing ETH price can never flatter or punish the number
        priced_share = shares if row["unpriced"] == 0 else shares * (row["buys"] - row["unpriced"]) / row["buys"]
        avg = (row["usdSpent"] / priced_share) if priced_share > 0 and row["usdSpent"] > 0 else None
        value = shares * px if px is not None else None
        cost_all = avg * shares if avg is not None else None
        pnl = (value - cost_all) if (value is not None and cost_all is not None) else None
        names.append({
            "symbol": m.get("symbol", t[:8]), "token": row["token"], "buys": row["buys"],
            "shares": round(shares, 6), "usdSpent": round(cost_all, 2) if cost_all is not None else None,
            "avgCost": round(avg, 4) if avg is not None else None, "price": round(px, 4) if px is not None else None,
            "value": round(value, 2) if value is not None else None,
            "pnlUsd": round(pnl, 2) if pnl is not None else None,
            "pnlPct": round((px / avg - 1) * 100, 2) if (avg and px is not None) else None,
            "firstBuy": row["firstBuy"], "lastBuy": row["lastBuy"], "unpricedBuys": row["unpriced"],
        })
        if cost_all is not None and value is not None:
            tot_spent += cost_all
            tot_value += value
    names.sort(key=lambda n: (n["pnlUsd"] is None, -(n["pnlUsd"] or 0)))
    return {
        "names": names,
        "totals": {"usdSpent": round(tot_spent, 2), "value": round(tot_value, 2),
                   "pnlUsd": round(tot_value - tot_spent, 2),
                   "pnlPct": round((tot_value / tot_spent - 1) * 100, 2) if tot_spent > 0 else None},
    }


def build(w3, booster_address: str, previous: Optional[Dict], from_block: int, chunk: int = 2_500_000) -> Dict:
    from web3 import Web3
    booster = w3.eth.contract(address=Web3.to_checksum_address(booster_address), abi=BOOSTER_ABI)
    events: List[Dict] = list((previous or {}).get("events", [])) if (previous or {}).get("stateVersion") == STATE_VERSION else []
    start = max(from_block, (events[-1]["block"] + 1) if events else from_block)
    latest = int(w3.eth.block_number)
    topic = _topic(w3)
    new_logs = []
    for a in range(start, latest + 1, chunk):
        new_logs += w3.eth.get_logs({"address": booster.address, "fromBlock": a, "toBlock": min(a + chunk - 1, latest), "topics": [topic]})
    eth_feed = w3.eth.contract(address=booster.functions.ethUsdFeed().call(), abi=FEED_ABI)
    rounds = RoundIndex(eth_feed) if new_logs else None
    meta_cache: Dict[str, Dict] = {m["token"].lower(): m for m in (previous or {}).get("tokens", [])}
    block_ts: Dict[int, int] = {}
    for lg in new_logs:
        token = Web3.to_checksum_address("0x" + lg["topics"][1].hex()[-40:])
        data = bytes(lg["data"]) if not isinstance(lg["data"], str) else bytes.fromhex(lg["data"][2:])
        eth_in = int.from_bytes(data[:32], "big"); token_out = int.from_bytes(data[32:64], "big")
        bn = int(lg["blockNumber"])
        if bn not in block_ts:
            block_ts[bn] = int(w3.eth.get_block(bn)["timestamp"])
        ts = block_ts[bn]
        m = meta_cache.get(token.lower())
        if m is None:
            tc = w3.eth.contract(address=token, abi=TOKEN_ABI)
            try:
                mult = int(tc.functions.uiMultiplier().call())
            except Exception:
                mult = WEI
            m = {"token": token, "symbol": tc.functions.symbol().call(), "decimals": int(tc.functions.decimals().call()), "uiMultiplier": mult}
            meta_cache[token.lower()] = m
        shares_raw = token_out * m["uiMultiplier"] // WEI * WEI // (10 ** m["decimals"])  # display shares x 1e18
        eth_usd = rounds.price_at(ts) if rounds else None
        events.append({"block": bn, "ts": ts, "tx": lg["transactionHash"].hex() if not isinstance(lg["transactionHash"], str) else lg["transactionHash"],
                       "token": token, "ethIn": str(eth_in), "sharesRaw": shares_raw,
                       "ethUsd": eth_usd, "usdIn": (eth_in / WEI * eth_usd) if eth_usd else None})
    events.sort(key=lambda e: (e["block"], e["tx"]))
    # live prices from the Booster's own stock feeds
    prices: Dict[str, float] = {}
    for t, m in meta_cache.items():
        feed = booster.functions.stockFeed(Web3.to_checksum_address(m["token"])).call()
        if int(feed, 16) == 0:
            continue
        fc = w3.eth.contract(address=feed, abi=FEED_ABI)
        try:
            prices[t] = int(fc.functions.latestRoundData().call()[1]) / 10 ** int(fc.functions.decimals().call())
        except Exception:
            continue
    agg = aggregate(events, prices, meta_cache)
    return {
        "stateVersion": STATE_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "block": latest,
        "purchases": len(events),
        "tokens": list(meta_cache.values()),
        "names": agg["names"],
        "totals": agg["totals"],
        "note": "engine cost (ETH at the Chainlink ETH/USD round of each purchase) vs today's Chainlink stock price, assuming shares are still held",
        "events": events,
    }


def main() -> int:
    import argparse
    import os
    import urllib.request

    ap = argparse.ArgumentParser(description="Build the basket scorecard (incremental)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--previous-url", default=os.environ.get("SCORECARD_DATA_URL", ""))
    ap.add_argument("--from-block", type=int, default=int(os.environ.get("BROKER_DEPLOYMENT_BLOCK", "39460869")))
    args = ap.parse_args()
    from config import make_web3, BOOSTER_ADDRESS
    previous = None
    if args.previous_url:
        try:
            with urllib.request.urlopen(urllib.request.Request(args.previous_url, headers={"User-Agent": "coattail-indexer/1.0"}), timeout=30) as r:
                previous = json.load(r)
        except Exception as exc:  # first run, or the data branch is unreachable: rebuild from scratch
            print(f"previous scorecard unavailable ({str(exc)[:80]}); full rebuild")
    if not BOOSTER_ADDRESS:
        raise SystemExit("set BOOSTER_ADDRESS")
    sc = build(make_web3(), BOOSTER_ADDRESS, previous, args.from_block)
    json.dump(sc, open(args.out, "w"))
    t = sc["totals"]
    print(f"scorecard: {sc['purchases']} purchases, spent ${t['usdSpent']:,.2f}, value ${t['value']:,.2f}, "
          f"pnl ${t['pnlUsd']:,.2f} ({t['pnlPct']}%) -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
