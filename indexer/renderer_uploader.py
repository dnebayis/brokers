#!/usr/bin/env python3
"""Resumable 1,776-token renderer upload and tokenURI verification runner."""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path

from config import CHAIN_ID, RPC_URL

MAX_SUPPLY = 1776
MAX_BATCH = 5
SCRIPT_DIR = Path(__file__).resolve().parent


def payload(collection: Path, token_id: int) -> tuple[bytes, bytes]:
    bitmap = (collection / f"{token_id}.bin").read_bytes()
    traits = bytes.fromhex((collection / f"{token_id}.traits").read_text().strip().removeprefix("0x"))
    if len(bitmap) != 200 or len(traits) != 8:
        raise RuntimeError(f"invalid canonical payload for token {token_id}")
    return bitmap, traits


def decode_uri(uri: str, token_id: int) -> dict:
    prefix = "data:application/json;base64,"
    if not uri.startswith(prefix):
        raise RuntimeError(f"token {token_id} is not on-chain JSON")
    document = json.loads(base64.b64decode(uri[len(prefix):]))
    if document.get("name") != f"Coattail Broker #{token_id}":
        raise RuntimeError(f"token {token_id} name mismatch")
    if len(document.get("attributes", [])) != 7:
        raise RuntimeError(f"token {token_id} trait count mismatch")
    image_prefix = "data:image/svg+xml;base64,"
    image = document.get("image", "")
    if not image.startswith(image_prefix):
        raise RuntimeError(f"token {token_id} image is not embedded SVG")
    svg = base64.b64decode(image[len(image_prefix):]).decode()
    if 'viewBox="0 0 40 40"' not in svg:
        raise RuntimeError(f"token {token_id} SVG dimensions mismatch")
    return document


def write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--max-batches", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=MAX_BATCH)
    parser.add_argument("--gas-limit", type=int)
    parser.add_argument("--broadcast-all", action="store_true",
                        help="broadcast every remaining batch first; reconcile receipts in a later run")
    parser.add_argument("--receipt-only", action="store_true",
                        help="record confirmed receipts now; defer full payload/tokenURI checks to --verify-only")
    parser.add_argument("--collection", type=Path, default=SCRIPT_DIR.parent / "pipeline/collection")
    parser.add_argument("--state", type=Path, default=SCRIPT_DIR / "renderer-upload-state.json")
    args = parser.parse_args()
    if args.max_batches < 1:
        raise RuntimeError("--max-batches must be positive")
    if args.batch_size < 1:
        raise RuntimeError("--batch-size must be positive")
    renderer_address = os.environ.get("RENDERER_ADDRESS", "")
    if not renderer_address:
        raise RuntimeError("RENDERER_ADDRESS is required")

    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected() or w3.eth.chain_id != CHAIN_ID:
        raise RuntimeError("RPC unavailable or wrong chain")
    renderer = w3.eth.contract(address=Web3.to_checksum_address(renderer_address), abi=[
        {"type": "function", "name": "uploadArt", "stateMutability": "nonpayable",
         "inputs": [{"name": "tokenIds", "type": "uint256[]"},
                    {"name": "bitmaps", "type": "bytes[]"},
                    {"name": "traits", "type": "bytes8[]"}], "outputs": []},
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

    if args.verify_only:
        for token_id in range(1, MAX_SUPPLY + 1):
            expected_bitmap, expected_traits = payload(args.collection, token_id)
            if bytes(renderer.functions.bitmapOf(token_id).call()) != expected_bitmap:
                raise RuntimeError(f"token {token_id} bitmap mismatch")
            if bytes(renderer.functions.traitsOf(token_id).call()) != expected_traits:
                raise RuntimeError(f"token {token_id} traits mismatch")
            decode_uri(renderer.functions.tokenURI(token_id).call(), token_id)
        print(json.dumps({"verified": MAX_SUPPLY, "chainId": CHAIN_ID, "renderer": renderer.address}))
        return

    state = {"nextTokenId": 1, "receipts": []}
    if args.state.exists():
        state = json.loads(args.state.read_text())
    start = int(state.get("nextTokenId", 1))
    if not 1 <= start <= MAX_SUPPLY + 1:
        raise RuntimeError("renderer cursor out of range")
    private_key = os.environ.get("ART_UPLOADER_PRIVATE_KEY", "")
    account = w3.eth.account.from_key(private_key) if args.execute and private_key else None
    if args.execute and account is None:
        raise RuntimeError("ART_UPLOADER_PRIVATE_KEY is required with --execute")

    # A broadcast-first run persists every submitted transaction before moving
    # to the next nonce. A later normal execution turns these pending entries
    # into verified receipts, so an interruption can never silently skip art.
    if args.broadcast_all:
        if not args.execute:
            raise RuntimeError("--broadcast-all requires --execute")
        if state.get("pending"):
            raise RuntimeError("pending uploads must be reconciled before another broadcast-all run")
        nonce = w3.eth.get_transaction_count(account.address, "pending")
        for _ in range(args.max_batches):
            if start > MAX_SUPPLY:
                break
            ids = list(range(start, min(start + args.batch_size, MAX_SUPPLY + 1)))
            rows = [payload(args.collection, token_id) for token_id in ids]
            transaction = {"from": account.address, "nonce": nonce, "chainId": CHAIN_ID}
            if args.gas_limit is not None:
                transaction["gas"] = args.gas_limit
            tx = renderer.functions.uploadArt(ids, [row[0] for row in rows], [row[1] for row in rows]).build_transaction(transaction)
            signed = account.sign_transaction(tx)
            raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
            tx_hash = w3.eth.send_raw_transaction(raw).hex()
            state.setdefault("pending", []).append({"tokenIds": ids, "tx": tx_hash})
            start = ids[-1] + 1
            nonce += 1
            state["nextTokenId"] = start
            write_state(args.state, state)
            print(json.dumps({"broadcast": ids, "tx": tx_hash}))
        return

    pending = state.get("pending", [])
    while pending:
        entry = pending[0]
        receipt = w3.eth.wait_for_transaction_receipt(entry["tx"], timeout=300)
        if receipt.status != 1:
            raise RuntimeError(f"upload receipt status {receipt.status}: {entry['tx']}")
        ids = entry["tokenIds"]
        if not args.receipt_only:
            rows = [payload(args.collection, token_id) for token_id in ids]
            for token_id, (expected_bitmap, expected_traits) in zip(ids, rows):
                if bytes(renderer.functions.bitmapOf(token_id).call()) != expected_bitmap:
                    raise RuntimeError(f"post-upload bitmap mismatch: {token_id}")
                if bytes(renderer.functions.traitsOf(token_id).call()) != expected_traits:
                    raise RuntimeError(f"post-upload traits mismatch: {token_id}")
                decode_uri(renderer.functions.tokenURI(token_id).call(), token_id)
        state["receipts"].append({"tokenIds": ids, "tx": entry["tx"], "block": receipt.blockNumber})
        pending = pending[1:]
        if pending:
            state["pending"] = pending
        else:
            state.pop("pending", None)
        write_state(args.state, state)

    for _ in range(args.max_batches):
        if start > MAX_SUPPLY:
            break
        ids = list(range(start, min(start + args.batch_size, MAX_SUPPLY + 1)))
        rows = [payload(args.collection, token_id) for token_id in ids]
        print(json.dumps({"batch": ids, "execute": args.execute}))
        if not args.execute:
            break
        transaction = {
            "from": account.address,
            "nonce": w3.eth.get_transaction_count(account.address, "pending"),
            "chainId": CHAIN_ID,
        }
        # Larger testnet batches are safe when their limit is supplied from a
        # measured successful upload; omitting it preserves RPC gas estimation.
        if args.gas_limit is not None:
            transaction["gas"] = args.gas_limit
        tx = renderer.functions.uploadArt(
            ids, [row[0] for row in rows], [row[1] for row in rows]
        ).build_transaction(transaction)
        signed = account.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        tx_hash = w3.eth.send_raw_transaction(raw)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
        if receipt.status != 1:
            raise RuntimeError(f"upload receipt status {receipt.status}: {tx_hash.hex()}")
        for token_id, (expected_bitmap, expected_traits) in zip(ids, rows):
            if bytes(renderer.functions.bitmapOf(token_id).call()) != expected_bitmap:
                raise RuntimeError(f"post-upload bitmap mismatch: {token_id}")
            if bytes(renderer.functions.traitsOf(token_id).call()) != expected_traits:
                raise RuntimeError(f"post-upload traits mismatch: {token_id}")
            decode_uri(renderer.functions.tokenURI(token_id).call(), token_id)
        state["receipts"].append({"tokenIds": ids, "tx": tx_hash.hex(), "block": receipt.blockNumber})
        start = ids[-1] + 1
        state["nextTokenId"] = start
        write_state(args.state, state)


if __name__ == "__main__":
    main()
