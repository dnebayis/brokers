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
import hashlib
import json
import os
import time
import urllib.request
from datetime import date
from pathlib import Path

from config import CHAIN_ID, RPC_URL
from renderer_uploader import decode_uri

MAX_SUPPLY = 1776
SCRIPT_DIR = Path(__file__).resolve().parent

# RH Chain's public RPC sits behind Cloudflare, which 403s the default
# python User-Agent (error 1010); present a browser UA on every request.
RPC_HEADERS = {"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"}
SELECTOR = {"bitmapOf": "0x59df2902", "traitsOf": "0x5efab6e4", "tokenURI": "0xc87b56dd"}


def rpc_batch(url: str, calls: list[dict], attempts: int = 4) -> list[dict]:
    """POST a JSON-RPC 2.0 batch, retrying transient transport errors."""
    body = json.dumps(calls).encode()
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, data=body, headers=RPC_HEADERS)
            with urllib.request.urlopen(req, timeout=60) as response:
                payload = json.loads(response.read().decode())
            if not isinstance(payload, list):
                raise RuntimeError(f"unexpected RPC response: {str(payload)[:200]}")
            return sorted(payload, key=lambda item: item["id"])
        except Exception:  # noqa: BLE001 - transient RPC/transport; retry with backoff
            if attempt == attempts - 1:
                raise
            time.sleep(1.5 * (attempt + 1))


def eth_call(to: str, selector: str, token_id: int, req_id: int) -> dict:
    data = selector + f"{token_id:064x}"
    return {"jsonrpc": "2.0", "id": req_id, "method": "eth_call",
            "params": [{"to": to, "data": data}, "latest"]}


def decode_bytes(result: str) -> bytes:
    """Decode an ABI dynamic `bytes`/`string` return (offset, length, data)."""
    raw = bytes.fromhex(result[2:] if result.startswith("0x") else result)
    length = int.from_bytes(raw[32:64], "big")
    return raw[64:64 + length]


def load_manifest(path: Path) -> tuple[dict, dict]:
    manifest = json.loads(path.read_text())
    if manifest.get("count") != MAX_SUPPLY:
        raise RuntimeError(f"manifest count {manifest.get('count')} != {MAX_SUPPLY}")
    by_id = {int(token["tokenId"]): token for token in manifest["tokens"]}
    if len(by_id) != MAX_SUPPLY:
        raise RuntimeError("manifest is missing token ids")
    return manifest, by_id


def audit_token(token_id: int, expected: dict, bitmap: bytes, traits: bytes, uri: str) -> dict:
    """Compare one token's on-chain bytes against the manifest. No network here."""
    errors: list[str] = []
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
        decode_uri(uri, token_id)
    except Exception as exc:  # noqa: BLE001 - surfaced per token, never aborts the sweep
        errors.append(f"tokenURI: {exc}")

    return {
        "tokenId": token_id,
        "ok": not errors,
        "bitmapSha256": bitmap_sha,
        "traitsSha256": traits_sha,
        "errors": errors,
    }


KIND = ("bitmapOf", "traitsOf", "tokenURI")


def _usable(result) -> bool:
    # This RPC intermittently returns an empty "0x" for a valid eth_call under
    # load. A real return is always at least one 32-byte word.
    return isinstance(result, str) and result.startswith("0x") and len(result) >= 66


def fetch_chunk(to: str, token_ids: list[int], rounds: int = 6) -> dict[int, tuple[bytes, bytes, str]]:
    """Batch bitmapOf/traitsOf/tokenURI for many tokens, re-requesting empties."""
    results: dict[int, str] = {}
    pending = [(token_id, kind) for token_id in token_ids for kind in range(3)]
    for attempt in range(rounds):
        calls = [eth_call(to, SELECTOR[KIND[kind]], token_id, token_id * 10 + kind)
                 for token_id, kind in pending]
        for item in rpc_batch(RPC_URL, calls):
            if _usable(item.get("result")):
                results[item["id"]] = item["result"]
        pending = [(t, k) for t, k in pending if (t * 10 + k) not in results]
        if not pending:
            break
        time.sleep(1.0 + attempt)
    if pending:
        raise RuntimeError(f"RPC never returned {len(pending)} calls, e.g. {pending[:3]}")

    out: dict[int, tuple[bytes, bytes, str]] = {}
    for token_id in token_ids:
        bitmap = decode_bytes(results[token_id * 10 + 0])
        traits = bytes.fromhex(results[token_id * 10 + 1][2:])[:8]  # bytes8, left-aligned
        uri = decode_bytes(results[token_id * 10 + 2]).decode()
        out[token_id] = (bitmap, traits, uri)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path,
                        default=SCRIPT_DIR.parent / "pipeline/collection-manifest.json")
    parser.add_argument("--out", type=Path,
                        default=SCRIPT_DIR / f"reports/renderer-readback-{date.today().isoformat()}.json")
    parser.add_argument("--fail-fast", action="store_true")
    parser.add_argument("--chunk", type=int, default=12, help="tokens per RPC batch")
    parser.add_argument("--delay", type=float, default=0.5, help="seconds between batches")
    args = parser.parse_args()

    renderer_address = os.environ.get("RENDERER_ADDRESS", "").lower()
    if not renderer_address.startswith("0x") or len(renderer_address) != 42:
        raise RuntimeError("RENDERER_ADDRESS must be a 0x-prefixed 20-byte address")

    manifest, by_id = load_manifest(args.manifest)

    # Confirm the endpoint is the expected chain before auditing.
    chain_hex = rpc_batch(RPC_URL, [{"jsonrpc": "2.0", "id": 0,
                                     "method": "eth_chainId", "params": []}])[0]["result"]
    if int(chain_hex, 16) != CHAIN_ID:
        raise RuntimeError(f"RPC chain {int(chain_hex, 16)} != expected {CHAIN_ID}")

    aggregate = hashlib.sha256()
    rows: list[dict] = []
    failures: list[dict] = []
    stop = False
    for start in range(1, MAX_SUPPLY + 1, args.chunk):
        ids = list(range(start, min(start + args.chunk, MAX_SUPPLY + 1)))
        fetched = fetch_chunk(renderer_address, ids)
        for token_id in ids:
            bitmap, traits, uri = fetched[token_id]
            row = audit_token(token_id, by_id[token_id], bitmap, traits, uri)
            rows.append(row)
            # Re-derive the manifest aggregate over on-chain bytes, in id order.
            aggregate.update(token_id.to_bytes(2, "big"))
            aggregate.update(bytes.fromhex(row["bitmapSha256"]))
            aggregate.update(bytes.fromhex(row["traitsSha256"]))
            if not row["ok"]:
                failures.append(row)
                if args.fail_fast:
                    stop = True
                    break
        print(json.dumps({"progress": rows[-1]["tokenId"], "failures": len(failures)}))
        if stop:
            break
        time.sleep(args.delay)

    onchain_aggregate = aggregate.hexdigest()
    aggregate_ok = (not failures) and onchain_aggregate == manifest["aggregateSha256"]

    report = {
        "chainId": CHAIN_ID,
        "renderer": renderer_address,
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
