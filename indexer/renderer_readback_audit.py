#!/usr/bin/env python3
"""Remote read-back audit: on-chain renderer state vs pipeline/collection-manifest.json.

STATUS.md remaining-work item 4. Reads every active token's on-chain bitmap, traits
and tokenURI directly from the deployed BrokerRenderer and proves each one against the
canonical manifest hashes, then re-derives the aggregate digest exactly as
pipeline/build_release_manifest.py did and asserts it matches. Structural checks on the
embedded JSON/SVG mirror renderer_uploader.decode_uri. Writes a per-token report so a
single failing token id is never hidden by an early abort.

Run where the Robinhood Chain RPC is reachable:

    NETWORK=testnet RENDERER_ADDRESS=0x<renderer> \
    python3 renderer_readback_audit.py --out reports/renderer-readback-<date>.json

Add --fail-fast to stop on the first mismatch instead of auditing all 1,776 tokens.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from datetime import date
from pathlib import Path

from config import CHAIN_ID, RPC_URL
from renderer_uploader import decode_uri

MAX_SUPPLY = 1776
SCRIPT_DIR = Path(__file__).resolve().parent


def load_manifest(path: Path) -> tuple[dict, dict]:
    manifest = json.loads(path.read_text())
    if manifest.get("count") != MAX_SUPPLY:
        raise RuntimeError(f"manifest count {manifest.get('count')} != {MAX_SUPPLY}")
    by_id = {int(token["tokenId"]): token for token in manifest["tokens"]}
    if len(by_id) != MAX_SUPPLY:
        raise RuntimeError("manifest is missing token ids")
    return manifest, by_id


def audit_token(renderer, token_id: int, expected: dict) -> dict:
    """Return {tokenId, ok, bitmapSha256, traitsSha256, errors[]} for one token."""
    errors: list[str] = []

    bitmap = bytes(renderer.functions.bitmapOf(token_id).call())
    traits = bytes(renderer.functions.traitsOf(token_id).call())
    bitmap_sha = hashlib.sha256(bitmap).hexdigest()
    traits_sha = hashlib.sha256(traits).hexdigest()

    if len(bitmap) != 200:
        errors.append(f"bitmap length {len(bitmap)} != 200")
    if len(traits) != 8:
        errors.append(f"traits length {len(traits)} != 8")
    if bitmap_sha != expected["bitmapSha256"]:
        errors.append("bitmap hash mismatch vs manifest")
    if traits_sha != expected["traitsSha256"]:
        errors.append("traits hash mismatch vs manifest")
    if "0x" + traits.hex() != expected["traitsHex"]:
        errors.append("traitsHex mismatch vs manifest")

    # Structural JSON/SVG proof of the on-chain render path.
    try:
        decode_uri(renderer.functions.tokenURI(token_id).call(), token_id)
    except Exception as exc:  # noqa: BLE001 - surfaced per token, never aborts the sweep
        errors.append(f"tokenURI: {exc}")

    return {
        "tokenId": token_id,
        "ok": not errors,
        "bitmapSha256": bitmap_sha,
        "traitsSha256": traits_sha,
        "errors": errors,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path,
                        default=SCRIPT_DIR.parent / "pipeline/collection-manifest.json")
    parser.add_argument("--out", type=Path,
                        default=SCRIPT_DIR / f"reports/renderer-readback-{date.today().isoformat()}.json")
    parser.add_argument("--fail-fast", action="store_true")
    args = parser.parse_args()

    renderer_address = os.environ.get("RENDERER_ADDRESS", "")
    if not renderer_address:
        raise RuntimeError("RENDERER_ADDRESS is required")

    manifest, by_id = load_manifest(args.manifest)

    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected() or w3.eth.chain_id != CHAIN_ID:
        raise RuntimeError("RPC unavailable or wrong chain")
    renderer = w3.eth.contract(address=Web3.to_checksum_address(renderer_address), abi=[
        {"type": "function", "name": "bitmapOf", "stateMutability": "view",
         "inputs": [{"name": "tokenId", "type": "uint256"}],
         "outputs": [{"name": "", "type": "bytes"}]},
        {"type": "function", "name": "traitsOf", "stateMutability": "view",
         "inputs": [{"name": "tokenId", "type": "uint256"}],
         "outputs": [{"name": "", "type": "bytes8"}]},
        {"type": "function", "name": "tokenURI", "stateMutability": "view",
         "inputs": [{"name": "tokenId", "type": "uint256"}],
         "outputs": [{"name": "", "type": "string"}]},
    ])

    aggregate = hashlib.sha256()
    rows: list[dict] = []
    failures: list[dict] = []
    for token_id in range(1, MAX_SUPPLY + 1):
        row = audit_token(renderer, token_id, by_id[token_id])
        rows.append(row)
        # Re-derive the manifest aggregate over on-chain bytes, in id order.
        aggregate.update(token_id.to_bytes(2, "big"))
        aggregate.update(bytes.fromhex(row["bitmapSha256"]))
        aggregate.update(bytes.fromhex(row["traitsSha256"]))
        if not row["ok"]:
            failures.append(row)
            if args.fail_fast:
                break

    onchain_aggregate = aggregate.hexdigest()
    aggregate_ok = (not failures) and onchain_aggregate == manifest["aggregateSha256"]

    report = {
        "chainId": CHAIN_ID,
        "renderer": renderer.address,
        "audited": len(rows),
        "failures": len(failures),
        "manifestAggregateSha256": manifest["aggregateSha256"],
        "onchainAggregateSha256": onchain_aggregate,
        "aggregateMatch": aggregate_ok,
        "failingTokens": failures,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")

    print(json.dumps({k: report[k] for k in
                      ("chainId", "renderer", "audited", "failures",
                       "aggregateMatch", "onchainAggregateSha256")}))
    if not aggregate_ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
