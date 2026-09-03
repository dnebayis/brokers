#!/usr/bin/env python3
"""Collection rank plan for BrokerRendererV4: Type first, then accessory rarity inside the type.

The seven art traits are fixed on chain; this derives one number per Broker from them:

    rank = position in the ordering (Type: Alien < Ape < Zombie < Female < Male,
           then, inside a type, the sum of -log2(frequency) over the six accessory
           slots descending, then token id ascending)

and a band label for the marketplace attribute. Bands grow so that OpenRarity's
information score orders them exactly as the plan does (2 tokens in the first band
score higher than 4 in the second, and so on). Writes:

    pipeline/rank-plan.json      one row per token: id, type, rank, band, bits
    contracts/ranks-v4.hex       1776 x uint16 big-endian ranks (3552 bytes) for the deploy

Run from the repository root:  python3 pipeline/rank_plan.py
"""

from __future__ import annotations

import collections
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MAX_SUPPLY = 1776
TYPES = ["Alien", "Ape", "Zombie", "Female", "Male"]
BAND_EDGES = [2, 6, 22, 72, 172, 372, 772, 1776]  # inclusive upper rank of each band


def band_label(rank: int) -> str:
    lo = 1
    for hi in BAND_EDGES:
        if rank <= hi:
            return f"{lo}-{hi}"
        lo = hi + 1
    raise ValueError(rank)


def load_traits() -> dict[int, bytes]:
    out = {}
    for i in range(1, MAX_SUPPLY + 1):
        h = (ROOT / "collection" / f"{i}.traits").read_text().strip()
        out[i] = bytes.fromhex(h[2:])[:7]
    return out


def plan(traits: dict[int, bytes]) -> list[dict]:
    counts = [collections.Counter(t[s] for t in traits.values()) for s in range(7)]
    n = len(traits)
    bits = {i: sum(-math.log2(counts[s][t[s]] / n) for s in range(1, 7)) for i, t in traits.items()}
    order = sorted(traits, key=lambda i: (traits[i][0], -bits[i], i))
    rows = []
    for pos, i in enumerate(order, start=1):
        rows.append({"id": i, "type": TYPES[traits[i][0]], "rank": pos, "band": band_label(pos),
                     "bits": round(bits[i], 4)})
    return sorted(rows, key=lambda r: r["id"])


def main() -> int:
    traits = load_traits()
    rows = plan(traits)
    ranks = sorted(r["rank"] for r in rows)
    assert ranks == list(range(1, MAX_SUPPLY + 1)), "ranks must be a permutation of 1..1776"
    packed = b"".join(r["rank"].to_bytes(2, "big") for r in rows)  # index = tokenId - 1
    digest = hashlib.sha3_256  # placeholder to keep linters quiet; keccak below
    try:
        from Crypto.Hash import keccak  # type: ignore

        k = keccak.new(digest_bits=256)
        k.update(packed)
        keccak_hex = k.hexdigest()
    except Exception:
        from web3 import Web3

        keccak_hex = Web3.keccak(packed).hex()[2:]
    del digest
    (ROOT / "rank-plan.json").write_text(json.dumps({
        "bands": BAND_EDGES, "keccak256": "0x" + keccak_hex, "tokens": rows}, indent=1) + "\n")
    (ROOT.parent / "contracts" / "ranks-v4.hex").write_text("0x" + packed.hex() + "\n")
    by_band = collections.Counter(r["band"] for r in rows)
    print("bands:", dict(sorted(by_band.items(), key=lambda kv: int(kv[0].split("-")[0]))))
    top = sorted(rows, key=lambda r: r["rank"])[:12]
    print("top 12:", [(r["id"], r["type"]) for r in top])
    print("keccak256(ranks):", "0x" + keccak_hex, "| bytes:", len(packed))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
