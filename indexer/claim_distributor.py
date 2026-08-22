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
    CLAIM_SWEEPER_ADDRESS,
    KEEPER_PRIVATE_KEY,
    NETWORK,
    make_web3,
)

MAX_SUPPLY = 1776
# claimBatch enforces MAX_CLAIM_BATCH=5 on chain; ClaimSweeper.claimMany just loops the
# uncapped claimFor, so 40 NFTs fit one tx (fork-measured: 20 brokers ~913k gas).
MAX_BATCH = 5
SWEEPER_BATCH = 40


def circular_ids(cursor: int):
    """Yield every collection ID once, starting at the persisted cursor."""
    start = min(max(cursor, 1), MAX_SUPPLY)
    for offset in range(MAX_SUPPLY):
        yield ((start - 1 + offset) % MAX_SUPPLY) + 1


def select_claim_batch(cursor: int, is_minted: Callable[[int], bool], has_claim: Callable[[int], bool],
                       max_batch: int = MAX_BATCH):
    selected = []
    last_scanned = cursor
    for token_id in circular_ids(cursor):
        last_scanned = token_id
        if is_minted(token_id) and has_claim(token_id):
            selected.append(token_id)
            if len(selected) == max_batch:
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
    # Prefer the ownerless ClaimSweeper: 40 NFTs per tx instead of claimBatch's on-chain
    # MAX of 5 — same permissionless claimFor underneath, ~8x fewer transactions.
    sweeper = None
    if CLAIM_SWEEPER_ADDRESS:
        sweeper = w3.eth.contract(address=Web3.to_checksum_address(CLAIM_SWEEPER_ADDRESS), abi=[
            {"type": "function", "name": "claimMany", "stateMutability": "nonpayable",
             "inputs": [{"name": "tokenIds", "type": "uint256[]"}], "outputs": []},
        ])
    batch_size = SWEEPER_BATCH if sweeper is not None else MAX_BATCH
    print(json.dumps({"claimPath": "sweeper.claimMany" if sweeper else "booster.claimBatch",
                      "batchSize": batch_size}))
    state = _read_state(args.state)

    def is_minted(token_id: int) -> bool:
        return token_id in minted_ids

    def has_claim(token_id: int) -> bool:
        _, amounts = booster.functions.claimable(token_id).call()
        return any(int(amount) > 0 for amount in amounts)

    account = w3.eth.account.from_key(KEEPER_PRIVATE_KEY) if args.execute and KEEPER_PRIVATE_KEY else None
    if args.execute and account is None:
        raise RuntimeError("KEEPER_PRIVATE_KEY is required with --execute")

    # Seed the nonce once and track it locally. RH's proxied RPC lags both ways on
    # get_transaction_count: "pending" can trail the confirmed "latest" count (it returned 1381 while
    # state was already 1382 right after the poke step's txs), so re-querying "pending" alone stays
    # stale and every claimBatch collides ("nonce too low"). Seed from max(pending, latest) and,
    # on a nonce error, advance to max(nonce+1, latest) so a lagging read can never pin us too low.
    def _best_nonce() -> int:
        return max(
            w3.eth.get_transaction_count(account.address, "pending"),
            w3.eth.get_transaction_count(account.address, "latest"),
        )

    nonce = _best_nonce() if account else 0

    for _ in range(args.max_batches):
        batch, next_cursor = select_claim_batch(int(state["nextTokenId"]), is_minted, has_claim,
                                                max_batch=batch_size)
        print(json.dumps({"cursor": state["nextTokenId"], "batch": batch, "nextCursor": next_cursor}))
        if not batch:
            state["nextTokenId"] = next_cursor
            _write_state(args.state, state)
            break
        if not args.execute:
            break

        # RH's proxied RPC can serve a stale state to eth_estimateGas right after a preceding tx,
        # undersizing the limit and reverting out-of-gas (which hard-stops the cursor here).
        # Floor + 2x buffer removes that: RH gas is ~0.02 gwei so an oversized limit costs
        # nothing (only used gas is billed). Floors: 5-NFT claimBatch ~1.0M gas observed;
        # 40-NFT sweeper sweep extrapolates from the fork-measured 20-NFT/913k run.
        call = (sweeper.functions.claimMany(batch) if sweeper is not None
                else booster.functions.claimBatch(batch))
        estimate = call.estimate_gas({"from": account.address})
        gas_limit = max(int(estimate * 2), 6_000_000 if sweeper is not None else 2_500_000)
        tx_hash = None
        for send_try in range(4):
            tx = call.build_transaction({
                "from": account.address,
                "nonce": nonce,
                "chainId": CHAIN_ID,
                "gas": gas_limit,
            })
            signed = account.sign_transaction(tx)
            raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
            try:
                tx_hash = w3.eth.send_raw_transaction(raw)
                break
            except Exception as exc:
                if "nonce" in str(exc).lower() and send_try < 3:
                    nonce = max(nonce + 1, _best_nonce())
                    continue
                raise
        nonce += 1
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
        if receipt.status != 1:
            raise RuntimeError(f"claimBatch receipt status {receipt.status}: {tx_hash.hex()}")
        state["receipts"].append({"tokenIds": batch, "tx": tx_hash.hex(), "block": receipt.blockNumber})
        state["nextTokenId"] = next_cursor
        _write_state(args.state, state)


if __name__ == "__main__":
    main()
