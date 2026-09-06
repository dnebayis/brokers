"""Activation history: every Broker switched on or off, and what each switch-on burned.

The Broker contract emits `Activated(tokenId, owner, coatBurned)` and `Deactivated(tokenId)`.
Read together they give the whole activation curve of the collection and the cumulative
$COAT burned by activations, which the site's Stats tab draws over time. A browser cannot
read that history itself: a full-range `eth_getLogs` over the collection's lifetime times
out on the public endpoint, so the indexer scans it in chunks here and publishes the
result. Incremental: the published file carries every event, so a pass only fetches what
is newer than the last block it saw.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

WEI = 10**18
STATE_VERSION = 1

# Exact block timestamps for a pass's new events up to this many distinct blocks; past it
# (the first full build, or a long gap) timestamps are interpolated from sampled anchors so
# a rebuild costs dozens of block reads rather than thousands.
EXACT_TS_LIMIT = 300
ANCHOR_STEP = 250_000


def _topics(w3) -> Dict[str, str]:
    return {
        "activated": "0x" + w3.keccak(text="Activated(uint256,address,uint256)").hex().replace("0x", ""),
        "deactivated": "0x" + w3.keccak(text="Deactivated(uint256)").hex().replace("0x", ""),
    }


def interpolate(anchors: List[List[int]], block: int) -> int:
    """Unix time for `block` from sorted (block, ts) anchors, linear between, clamped outside."""
    if not anchors:
        return 0
    if block <= anchors[0][0]:
        return anchors[0][1]
    for i in range(1, len(anchors)):
        b0, t0 = anchors[i - 1]
        b1, t1 = anchors[i]
        if block <= b1:
            return int(t0 + (block - b0) * (t1 - t0) / (b1 - b0)) if b1 != b0 else t1
    b0, t0 = anchors[-2] if len(anchors) > 1 else anchors[-1]
    b1, t1 = anchors[-1]
    return int(t1 + (block - b1) * (t1 - t0) / (b1 - b0)) if b1 != b0 else t1


def merge(previous: Optional[Dict], new_events: List[List], scanned_to: int, generated_at: str) -> Dict:
    """Pure: fold `new_events` ([block, ts, tokenId, active, burned]) into the previous file.

    Events are keyed by (block, tokenId, active) so a rescan of an already-published block
    never doubles a switch. Totals are recomputed from the full list, so a state that once
    went wrong heals on the next pass rather than compounding.
    """
    events: List[List] = list((previous or {}).get("events", [])) if (previous or {}).get("stateVersion") == STATE_VERSION else []
    seen = {(e[0], e[2], e[3]) for e in events}
    for e in new_events:
        key = (e[0], e[2], e[3])
        if key in seen:
            continue
        seen.add(key)
        events.append(list(e))
    events.sort(key=lambda e: (e[0], e[2], -e[3]))  # a switch-off after a switch-on in one block would be odd; keep on first
    state: Dict[int, bool] = {}
    burned = 0.0
    activations = deactivations = 0
    for e in events:
        state[e[2]] = bool(e[3])
        if e[3]:
            activations += 1
            burned += float(e[4])
        else:
            deactivations += 1
    return {
        "stateVersion": STATE_VERSION,
        "generatedAt": generated_at,
        "scannedTo": scanned_to,
        "events": events,
        "totals": {
            "activations": activations,
            "deactivations": deactivations,
            "activeNow": sum(1 for v in state.values() if v),
            "burned": round(burned, 6),
        },
    }


def scan_logs(get_logs, start: int, latest: int, chunk: int, min_chunk: int = 20_000) -> List:
    """Chunked log scan that halves the window when the node refuses a range.

    The Broker contract has a long history and the public endpoint answers a wide
    `eth_getLogs` with "log query timed out"; a narrower window succeeds. `get_logs` takes
    (from_block, to_block) and returns the logs, so the retry policy stays testable.
    """
    out: List = []
    a = start
    while a <= latest:
        end = min(a + chunk - 1, latest)
        try:
            out += get_logs(a, end)
            a = end + 1
        except Exception as exc:
            if chunk <= min_chunk:
                raise
            chunk = max(min_chunk, chunk // 2)
            print(f"activations: range {a}-{end} refused ({str(exc)[:60]}); retrying with {chunk}-block windows")
            time.sleep(1)  # a refusal is often a rate limit as much as a timeout; give the node a beat
    return out


def build(w3, broker_address: str, previous: Optional[Dict], from_block: int, chunk: int = 500_000) -> Dict:
    from web3 import Web3
    broker = Web3.to_checksum_address(broker_address)
    prev_ok = (previous or {}).get("stateVersion") == STATE_VERSION
    start = max(from_block, int(previous["scannedTo"]) + 1) if prev_ok and previous.get("scannedTo") else from_block
    latest = int(w3.eth.block_number)
    topics = _topics(w3)
    both = [[topics["activated"], topics["deactivated"]]]
    logs = scan_logs(lambda a, b: w3.eth.get_logs({"address": broker, "fromBlock": a, "toBlock": b, "topics": both}), start, latest, chunk)
    blocks = sorted({int(lg["blockNumber"]) for lg in logs})
    block_ts: Dict[int, int] = {}
    if blocks and len(blocks) <= EXACT_TS_LIMIT:
        for bn in blocks:
            try:
                block_ts[bn] = int(w3.eth.get_block(bn)["timestamp"])
            except Exception:
                pass
    missing = [b for b in blocks if b not in block_ts]
    if missing:
        lo, hi = min(missing), max(missing)
        sample = list(range(lo, hi + 1, ANCHOR_STEP))
        if sample[-1] != hi:
            sample.append(hi)
        anchors: List[List[int]] = []
        for bn in sample:
            try:
                anchors.append([bn, int(w3.eth.get_block(bn)["timestamp"])])
            except Exception:
                pass
        for bn in missing:
            block_ts[bn] = interpolate(anchors, bn)
    new_events: List[List] = []
    for lg in logs:
        t0 = lg["topics"][0]
        t0 = t0.hex() if not isinstance(t0, str) else t0
        t0 = "0x" + t0.replace("0x", "")
        token_id = int(lg["topics"][1].hex() if not isinstance(lg["topics"][1], str) else lg["topics"][1], 16)
        bn = int(lg["blockNumber"])
        if t0 == topics["activated"]:
            data = bytes(lg["data"]) if not isinstance(lg["data"], str) else bytes.fromhex(lg["data"][2:])
            burned = int.from_bytes(data[:32], "big") / WEI
            new_events.append([bn, block_ts.get(bn, 0), token_id, 1, round(burned, 6)])
        else:
            new_events.append([bn, block_ts.get(bn, 0), token_id, 0, 0])
    return merge(previous, new_events, latest, datetime.now(timezone.utc).isoformat(timespec="seconds"))


def main() -> int:
    import argparse
    import os
    import urllib.request

    ap = argparse.ArgumentParser(description="Build the activation history (incremental)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--previous-url", default=os.environ.get("ACTIVATIONS_DATA_URL", ""))
    ap.add_argument("--from-block", type=int, default=int(os.environ.get("BROKER_DEPLOYMENT_BLOCK", "39460869")))
    args = ap.parse_args()
    from config import make_web3, BROKER_ADDRESS
    previous = None
    if args.previous_url:
        try:
            with urllib.request.urlopen(urllib.request.Request(args.previous_url, headers={"User-Agent": "coattail-indexer/1.0"}), timeout=30) as r:
                previous = json.load(r)
        except Exception as exc:  # first run, or the data branch is unreachable: rebuild from scratch
            print(f"previous activation history unavailable ({str(exc)[:80]}); full rebuild")
    if not BROKER_ADDRESS:
        raise SystemExit("set BROKER_ADDRESS")
    out = build(make_web3(), BROKER_ADDRESS, previous, args.from_block)
    json.dump(out, open(args.out, "w"), separators=(",", ":"))
    t = out["totals"]
    print(f"activations: {t['activations']} on, {t['deactivations']} off, {t['activeNow']} active now, "
          f"{t['burned']:,.0f} COAT burned; scanned to {out['scannedTo']} -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
