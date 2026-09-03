#!/usr/bin/env python3
"""Sample what OpenSea currently serves for Brokers and say which renderer shape it is.

    OPENSEA_API_KEY=... python3 scripts/opensea_check.py            # 24 fixed + random ids
    OPENSEA_API_KEY=... python3 scripts/opensea_check.py 1 12 1334   # specific ids

Shapes: v4 = attributes are exactly Type + Rank band; v3 = the seven art traits only;
v2 = numeric live traits present; v1 = a Status trait present. Read-only, one request per id.
"""

import json
import os
import random
import sys
import time
import urllib.request

CHAIN = os.environ.get("OPENSEA_CHAIN", "robinhood")
CONTRACT = os.environ.get("BROKER_ADDRESS", "0x1122dB21998707F8c2eD8182734356C947fA5e98")
KEY = os.environ.get("OPENSEA_API_KEY", "")
if not KEY:
    raise SystemExit("set OPENSEA_API_KEY")
FIXED = {"Type", "Headwear", "Eyes", "Mouth", "Jewelry", "Face", "Accessory"}


def shape(traits):
    kinds = [t.get("trait_type") for t in traits]
    if kinds == ["Type", "Rank band"]:
        return "v4"
    if "Status" in kinds:
        return "v1"
    if any(t.get("display_type") == "number" for t in traits):
        return "v2"
    if kinds and set(kinds) <= FIXED:
        return "v3"
    return "?"


ids = [int(a) for a in sys.argv[1:]]
if not ids:
    random.seed(int(time.time()))
    ids = sorted({1, 12, 405, 1176, 1334, 1018, 58, 913, 930, 1776} | set(random.sample(range(1, 1777), 14)))
tally = {}
for tid in ids:
    req = urllib.request.Request(
        f"https://api.opensea.io/api/v2/chain/{CHAIN}/contract/{CONTRACT}/nfts/{tid}",
        headers={"x-api-key": KEY, "Accept": "application/json", "User-Agent": "Mozilla/5.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            nft = json.load(r).get("nft", {})
        s = shape(nft.get("traits") or [])
        band = next((t.get("value") for t in nft.get("traits") or [] if t.get("trait_type") == "Rank band"), "")
        print(f"#{tid:4d} {s:3s} {band}  (updated {str(nft.get('updated_at', ''))[:19]})")
    except Exception as exc:  # keep sampling; one failure must not end the report
        s = "err"
        print(f"#{tid:4d} err {str(exc)[:80]}")
    tally[s] = tally.get(s, 0) + 1
    time.sleep(0.6)
print("summary:", tally)
