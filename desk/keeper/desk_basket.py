#!/usr/bin/env python3
"""Show or change the Desk's basket on the local fork (the registry's desk strategy slot).

    python3 keeper/desk_basket.py show
    python3 keeper/desk_basket.py set tAAPL=50 tMSFT=30 tNVDA=20

The registry refuses a move of more than its drift limit (30% turnover on testnet) in one
epoch; bigger moves go in steps. Local fork only: the deployer is impersonated.
"""

from __future__ import annotations

import json
import os
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
from web3 import Web3  # noqa: E402

DESK = Path(__file__).resolve().parents[1]
REGISTRY = [
    {"type": "function", "name": "getBasket", "stateMutability": "view", "inputs": [{"name": "id", "type": "uint256"}],
     "outputs": [{"type": "address[]"}, {"type": "uint16[]"}, {"type": "uint64"}]},
    {"type": "function", "name": "setStrategy", "stateMutability": "nonpayable",
     "inputs": [{"name": "id", "type": "uint256"}, {"name": "t", "type": "address[]"}, {"name": "w", "type": "uint16[]"}],
     "outputs": []},
    {"type": "function", "name": "maxDriftBps", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint16"}]},
]


def main() -> int:
    rpc = os.environ.get("RPC", "http://127.0.0.1:8545")
    if "127.0.0.1" not in rpc and "localhost" not in rpc:
        print("local fork only")
        return 1
    A = json.loads(Path(os.environ.get("DESK_ADDRESSES", DESK / "rehearsal" / "local-fork-addresses.json")).read_text())
    by_sym = {"tAAPL": A["taapl"], "tMSFT": A["tmsft"], "tNVDA": A["tnvda"]}
    sym_of = {v.lower(): k for k, v in by_sym.items()}
    w3 = Web3(Web3.HTTPProvider(rpc))
    reg = w3.eth.contract(address=Web3.to_checksum_address(A["registry"]), abi=REGISTRY)
    sid = int(A["strategyId"])

    def show() -> tuple[dict, int]:
        t, w, e = reg.functions.getBasket(sid).call()
        cur = {sym_of.get(x.lower(), x): y / 100 for x, y in zip(t, w)}
        print(f"epoch {e}: " + ", ".join(f"{k} {v:g}%" for k, v in cur.items()))
        return cur, e

    if len(sys.argv) < 2 or sys.argv[1] == "show":
        show()
        return 0
    if sys.argv[1] != "set":
        print(__doc__)
        return 1
    want = {}
    for arg in sys.argv[2:]:
        k, v = arg.split("=")
        want[k] = float(v)
    if abs(sum(want.values()) - 100) > 1e-9:
        print(f"weights add up to {sum(want.values()):g}%, need 100%")
        return 1
    cur, _ = show()
    turnover = sum(abs(want.get(k, 0) - cur.get(k, 0)) for k in set(want) | set(cur)) / 2
    limit = reg.functions.maxDriftBps().call() / 100
    if turnover > limit:
        print(f"that moves {turnover:g}% of the basket; the registry allows {limit:g}% per epoch. Go in steps.")
        return 1
    tokens = [Web3.to_checksum_address(by_sym[k]) for k in want]
    weights = [round(v * 100) for v in want.values()]
    h = w3.eth.send_transaction(reg.functions.setStrategy(sid, tokens, weights).build_transaction(
        {"from": Web3.to_checksum_address(A["deployer"])}))
    rc = w3.eth.wait_for_transaction_receipt(h)
    print("posted" if rc.status == 1 else "reverted")
    show()
    return 0 if rc.status == 1 else 1


if __name__ == "__main__":
    sys.exit(main())
