#!/usr/bin/env python3
"""ffi helper for ForkRialtoExecutor: fetch one allowance-settlement quote from the Rialto
Router API and print abi.encode(address to, bytes data, uint256 minBuy, uint256 sellRaw).

The API key is read from RIALTO_API_KEY or indexer/.env and is never printed.
usage: rialto_quote.py <sell_token> <buy_token> <sell_amount_human> <taker> [slippage_bps]
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from eth_abi import encode

API = "https://rialto-trade-api.rialto.xyz/quote"


def api_key() -> str:
    key = os.environ.get("RIALTO_API_KEY", "").strip()
    if key:
        return key
    env = Path(__file__).resolve().parents[3] / "indexer" / ".env"
    for line in env.read_text().splitlines():
        if line.startswith("RIALTO_API_KEY="):
            key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key:
        raise SystemExit("RIALTO_API_KEY missing")
    return key


def main() -> None:
    sell, buy, amount, taker = sys.argv[1:5]
    slippage = int(sys.argv[5]) if len(sys.argv) > 5 else 50
    q = urllib.parse.urlencode({
        "sell_token": sell, "buy_token": buy, "sell_amount": amount, "taker": taker,
        "slippage_bps": slippage, "chain_id": 4663, "settlement": "allowance",
    })
    req = urllib.request.Request(f"{API}?{q}", headers={
        "Authorization": "Bearer " + api_key(), "User-Agent": "coattail-fork-test",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        d = json.load(resp)
    if d.get("settlement") != "allowance":
        raise SystemExit(f"unexpected settlement {d.get('settlement')}")
    spender = ((d.get("issues") or {}).get("allowance") or {}).get("spender") or d["tx"]["to"]
    if spender.lower() != d["tx"]["to"].lower():
        raise SystemExit(f"spender {spender} != tx.to {d['tx']['to']}")
    out = encode(
        ["address", "bytes", "uint256", "uint256"],
        [d["tx"]["to"], bytes.fromhex(d["tx"]["data"][2:]), int(d["min_buy_amount"]), int(d["sell_amount"])],
    )
    sys.stdout.write("0x" + out.hex())


if __name__ == "__main__":
    main()
