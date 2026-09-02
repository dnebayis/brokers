#!/usr/bin/env python3
"""Ask OpenSea to re-read metadata for every Broker (or a range) after a renderer change.

There is no collection-wide refresh button; the API refresh endpoint is per token, so this
walks the ids with a gentle rate limit and retries on 429. Idempotent, safe to re-run.

    OPENSEA_API_KEY=... python3 scripts/opensea_refresh.py            # all 1..1776
    OPENSEA_API_KEY=... python3 scripts/opensea_refresh.py 1 200      # a range
"""
import os, sys, time, json, urllib.request, urllib.error

CHAIN = os.environ.get("OPENSEA_CHAIN", "robinhood")
CONTRACT = os.environ.get("BROKER_ADDRESS", "0x1122dB21998707F8c2eD8182734356C947fA5e98")
KEY = os.environ.get("OPENSEA_API_KEY", "")
if not KEY:
    raise SystemExit("set OPENSEA_API_KEY (the same key the site uses; it lives in the Vercel env)")

lo = int(sys.argv[1]) if len(sys.argv) > 1 else 1
hi = int(sys.argv[2]) if len(sys.argv) > 2 else 1776
ok = fail = 0
streak = 0  # consecutive failures: stop early instead of hammering a blocked endpoint
for tid in range(lo, hi + 1):
    if streak >= 5:
        print("5 failures in a row; stopping. Fix the cause (key / block) and re-run from this id.")
        break
    url = f"https://api.opensea.io/api/v2/chain/{CHAIN}/contract/{CONTRACT}/nfts/{tid}/refresh"
    # Cloudflare in front of OpenSea rejects the default python-urllib signature (error 1010),
    # so present an ordinary browser UA alongside the API key.
    req = urllib.request.Request(url, method="POST", headers={
        "x-api-key": KEY,
        "accept": "application/json",
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
    })
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                r.read()
            ok += 1
            streak = 0
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                time.sleep(2 * (attempt + 1))
                continue
            fail += 1
            streak += 1
            print(f"#{tid}: HTTP {e.code} {e.read()[:120]!r}")
            break
        except Exception as e:  # network blip: retry
            if attempt < 3:
                time.sleep(2)
                continue
            fail += 1
            streak += 1
            print(f"#{tid}: {e}")
    if tid % 100 == 0:
        print(f"... {tid}/{hi} queued (ok {ok}, failed {fail})")
    time.sleep(0.6)  # ~1.6 req/s, under OpenSea's refresh limit
print(f"done: {ok} refresh requests accepted, {fail} failed")
