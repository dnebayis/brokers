#!/usr/bin/env python3
"""Refresh the checked-in Robinhood Chain mainnet stock-token allowlist.

The resulting snapshot is deliberately checked in so the indexer never needs to
trust a live HTTP response while deciding whether it may post a basket.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen


ASSETS_URL = "https://api.robinhood.com/rhj/assets"
MAINNET_CHAIN_ID = 4663
TARGET = Path(__file__).with_name("tokens.py")


def fetch_mainnet_addresses() -> dict[str, str]:
    req = Request(ASSETS_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=30) as response:  # noqa: S310 -- fixed official HTTPS endpoint
        payload = json.load(response)

    assets = payload.get("assets")
    if not isinstance(assets, list):
        raise ValueError("Robinhood assets response has no assets list")

    addresses: dict[str, str] = {}
    for asset in assets:
        if asset.get("status") != "ASSET_STATUS_ACTIVE":
            continue
        symbol = asset.get("tokenSymbol")
        deployments = asset.get("deployments", [])
        mainnet = next((d.get("contractAddress") for d in deployments if d.get("chainId") == MAINNET_CHAIN_ID), None)
        if not isinstance(symbol, str) or not isinstance(mainnet, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", mainnet):
            continue
        if symbol in addresses:
            raise ValueError(f"duplicate active symbol: {symbol}")
        addresses[symbol] = mainnet

    if not addresses:
        raise ValueError("official registry yielded no active Robinhood Chain addresses")
    return dict(sorted(addresses.items()))


def render_mapping(addresses: dict[str, str]) -> str:
    lines = ["ADDRESS: dict[str, str] = {"]
    lines.extend(f'    "{symbol}": "{address}",' for symbol, address in addresses.items())
    lines.append("}")
    return "\n".join(lines)


def main() -> None:
    addresses = fetch_mainnet_addresses()
    source = TARGET.read_text()
    stamp = datetime.now(timezone.utc).date().isoformat()
    source = re.sub(
        r"Verified .*?\. Only these",
        f"Verified {stamp} from the official /rhj/assets registry. Only these",
        source,
        count=1,
    )
    source = re.sub(
        r"NOTE:[\s\S]*?(?=\n\"\"\"\n\n# ticker)",
        f"NOTE: this official active set contains {len(addresses)} tokens. A canonical address alone does not\nprove route liquidity; production basket admission must remain separately route-gated.\n",
        source,
        count=1,
    )
    marker = "ADDRESS: dict[str, str] = {"
    try:
        mapping_start = source.index(marker)
        mapping_end = source.index("\n}\n", mapping_start) + len("\n}\n")
    except ValueError as exc:
        raise ValueError("could not locate ADDRESS mapping in tokens.py")
    updated = source[:mapping_start] + render_mapping(addresses) + "\n" + source[mapping_end:]
    TARGET.write_text(updated)
    print(f"Saved {len(addresses)} active Robinhood Chain stock-token addresses to {TARGET}")


if __name__ == "__main__":
    main()
