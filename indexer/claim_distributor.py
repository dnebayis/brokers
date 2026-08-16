#!/usr/bin/env python3
"""Resumable permissionless distribution of accrued stock into Broker TBAs.

Random mint means token IDs cannot be inferred from totalMinted. The runner scans the
bounded 1..MAX_SUPPLY domain, skips unminted/zero-claim IDs, submits batches of at most
five, and advances its cursor only after a status=1 receipt.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Callable

from config import (
    BOOSTER_ADDRESS,
    BROKER_ADDRESS,
    BROKER_DEPLOYMENT_BLOCK,
    CHAIN_ID,
    KEEPER_PRIVATE_KEY,
    NETWORK,
    make_web3,
)

MAX_SUPPLY = 1776
MAX_BATCH = 5


def circular_ids(cursor: int):
    """Yield every collection ID once, starting at the persisted cursor."""
    start = min(max(cursor, 1), MAX_SUPPLY)
    for offset in range(MAX_SUPPLY):
        yield ((start - 1 + offset) % MAX_SUPPLY) + 1


def select_claim_batch(cursor: int, is_minted: Callable[[int], bool], has_claim: Callable[[int], bool]):
    selected = []
    last_scanned = cursor
    for token_id in circular_ids(cursor):
        last_scanned = token_id
        if is_minted(token_id) and has_claim(token_id):
            selected.append(token_id)
            if len(selected) == MAX_BATCH:
                break
    next_cursor = (last_scanned % MAX_SUPPLY) + 1
    return selected, next_cursor


def _read_state(path: Path) -> dict:
    if not path.exists():
        return {"nextTokenId": 1, "receipts": []}
    state = json.loads(path.read_text())
    cursor = int(state.get("nextTokenId", 1))
    if not 1 <= cursor <= MAX_SUPPLY:
        raise RuntimeError("claim state cursor is out of range")
    state.setdefault("receipts", [])
    return state


def _write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Distribute accrued stock to random-ID Broker TBAs")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--max-batches", type=int, default=1)
    parser.add_argument("--state", type=Path, default=Path(f"claim-state.{NETWORK}.json"))
    args = parser.parse_args()
    if args.max_batches < 1:
        raise RuntimeError("--max-batches must be positive")
    if not BROKER_ADDRESS or not BOOSTER_ADDRESS:
        raise RuntimeError("BROKER_ADDRESS and BOOSTER_ADDRESS are required")

    from web3 import Web3

    w3 = make_web3()
    broker_address = Web3.to_checksum_address(BROKER_ADDRESS)
    booster_address = Web3.to_checksum_address(BOOSTER_ADDRESS)
    broker = w3.eth.contract(address=broker_address, abi=[{
        "type": "function", "name": "ownerOf", "stateMutability": "view",
        "inputs": [{"name": "tokenId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "address"}],
    }])
    # Discover the minted token ids once from mint Transfer logs (from = 0x0) instead
    # of calling ownerOf across all 1..1776 ids each batch — the latter is thousands of
    # RPC calls and times out the scheduled run. Only ~minted ids are then price-checked.
    transfer_topic = "0x" + Web3.keccak(text="Transfer(address,address,uint256)").hex().lstrip("0x")
    zero_topic = "0x" + "0" * 64
    mint_logs = w3.eth.get_logs({
        "address": broker_address,
        "fromBlock": BROKER_DEPLOYMENT_BLOCK,
        "toBlock": "latest",
        "topics": [transfer_topic, zero_topic],
    })
    minted_ids = {int(log["topics"][3].hex(), 16) for log in mint_logs}
    print(json.dumps({"mintedDiscovered": len(minted_ids)}))
    booster = w3.eth.contract(address=booster_address, abi=[
        {"type": "function", "name": "claimable", "stateMutability": "view",
         "inputs": [{"name": "tokenId", "type": "uint256"}],
         "outputs": [{"name": "tokens", "type": "address[]"},
                     {"name": "amounts", "type": "uint256[]"}]},
        {"type": "function", "name": "claimBatch", "stateMutability": "nonpayable",
         "inputs": [{"name": "tokenIds", "type": "uint256[]"}], "outputs": []},
    ])
    state = _read_state(args.state)

    def is_minted(token_id: int) -> bool:
        return token_id in minted_ids

    def has_claim(token_id: int) -> bool:
        _, amounts = booster.functions.claimable(token_id).call()
        return any(int(amount) > 0 for amount in amounts)

    account = w3.eth.account.from_key(KEEPER_PRIVATE_KEY) if args.execute and KEEPER_PRIVATE_KEY else None
    if args.execute and account is None:
        raise RuntimeError("KEEPER_PRIVATE_KEY is required with --execute")

    for _ in range(args.max_batches):
        batch, next_cursor = select_claim_batch(int(state["nextTokenId"]), is_minted, has_claim)
        print(json.dumps({"cursor": state["nextTokenId"], "batch": batch, "nextCursor": next_cursor}))
        if not batch:
            state["nextTokenId"] = next_cursor
            _write_state(args.state, state)
            break
        if not args.execute:
            break

        tx = booster.functions.claimBatch(batch).build_transaction({
            "from": account.address,
            "nonce": w3.eth.get_transaction_count(account.address, "pending"),
            "chainId": CHAIN_ID,
        })
        signed = account.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        tx_hash = w3.eth.send_raw_transaction(raw)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
        if receipt.status != 1:
            raise RuntimeError(f"claimBatch receipt status {receipt.status}: {tx_hash.hex()}")
        state["receipts"].append({"tokenIds": batch, "tx": tx_hash.hex(), "block": receipt.blockNumber})
        state["nextTokenId"] = next_cursor
        _write_state(args.state, state)


if __name__ == "__main__":
    main()
