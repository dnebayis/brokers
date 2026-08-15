#!/usr/bin/env python3
"""Build the versioned hash manifest for the canonical on-chain art payloads."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from config import MAX_SUPPLY


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(collection: Path) -> dict:
    tokens = []
    aggregate = hashlib.sha256()
    for token_id in range(1, MAX_SUPPLY + 1):
        bitmap = collection / f"{token_id}.bin"
        traits = collection / f"{token_id}.traits"
        if not bitmap.exists() or not traits.exists():
            raise RuntimeError(f"missing canonical payload for token {token_id}")
        if bitmap.stat().st_size != 200:
            raise RuntimeError(f"token {token_id} bitmap is not 200 bytes")
        trait_bytes = bytes.fromhex(traits.read_text().strip().removeprefix("0x"))
        if len(trait_bytes) != 8:
            raise RuntimeError(f"token {token_id} traits are not bytes8")
        bitmap_hash = digest(bitmap)
        traits_hash = hashlib.sha256(trait_bytes).hexdigest()
        aggregate.update(token_id.to_bytes(2, "big"))
        aggregate.update(bytes.fromhex(bitmap_hash))
        aggregate.update(bytes.fromhex(traits_hash))
        tokens.append({
            "tokenId": token_id,
            "bitmapSha256": bitmap_hash,
            "traitsSha256": traits_hash,
            "traitsHex": "0x" + trait_bytes.hex(),
        })
    return {
        "schema": "coattail-art-manifest-v1",
        "count": MAX_SUPPLY,
        "aggregateSha256": aggregate.hexdigest(),
        "sourcePngsVersioned": False,
        "tokens": tokens,
    }


def main() -> None:
    root = Path(__file__).resolve().parent
    manifest = build(root / "collection")
    output = root / "collection-manifest.json"
    output.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(f"{output}: {manifest['count']} tokens, {manifest['aggregateSha256']}")


if __name__ == "__main__":
    main()
