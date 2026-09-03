#!/usr/bin/env python3
"""Record the V3 universe rewire in the route-ready manifest, AFTER the owner has run
rewire-v3-universe.sh on mainnet. Reads reports/route-v3-universe-plan.json (the probed
plan) and the fork probe report, rewrites each entry's stockPool/poolKind/probeBlock and
adds the four new names with their feeds. Refuses to touch a name whose on-chain route
does not already point at the planned pool, so the manifest can never run ahead of the chain.

    python3 apply_v3_universe.py            # verify on chain, then write
    python3 apply_v3_universe.py --dry-run  # verify only
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROUTER = "0x99F3f896B58bcb8A515ED3C7174c017B5a55075a"
MID_POOL = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca"
USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"


def main() -> int:
    dry = "--dry-run" in sys.argv
    plan = json.load(open(HERE / "reports" / "route-v3-universe-plan.json"))
    probe = {r["symbol"]: r for r in json.load(open(HERE.parent / "contracts" / "reports" / "route-v3-universe-probe.json"))}
    manifest_path = HERE / "route-ready.mainnet.json"
    manifest = json.load(open(manifest_path))
    from web3 import Web3
    from config import make_web3
    w3 = make_web3()
    router = w3.eth.contract(address=ROUTER, abi=[{"type": "function", "name": "routes", "stateMutability": "view",
        "inputs": [{"type": "address"}], "outputs": [{"type": "address"}, {"type": "address"}, {"type": "address"}, {"type": "uint8"}]}])
    bad = 0
    for row in plan:
        onchain = router.functions.routes(Web3.to_checksum_address(row["token"])).call()
        wired = onchain[2].lower() == row["pool"].lower() and onchain[3] == 1
        print(f"{row['symbol']:5s} chain={'V3 ok' if wired else 'NOT YET'} probe={probe.get(row['symbol'], {}).get('devBps', '?')} bps")
        if not wired:
            bad += 1
            continue
        entry = manifest["entries"].get(row["symbol"]) or {"token": row["token"], "midPool": MID_POOL, "midToken": USDG, "feed": row["feed"]}
        entry.update({"stockPool": row["pool"], "poolKind": "V3", "probeOk": True,
                      "probeBlock": probe.get(row["symbol"], {}).get("block", 0), "feed": row["feed"]})
        manifest["entries"][row["symbol"]] = entry
    if bad:
        print(f"{bad} name(s) not wired on chain yet; manifest untouched")
        return 1
    if dry:
        print("dry run: manifest would list", len(manifest["entries"]), "route-ready names")
        return 0
    json.dump(manifest, open(manifest_path, "w"), indent=2)
    open(manifest_path, "a").write("\n")
    print("wrote", manifest_path, "with", len(manifest["entries"]), "entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
