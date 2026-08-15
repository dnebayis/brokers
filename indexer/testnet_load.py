#!/usr/bin/env python3
"""Resumable 888-actor clean-testnet mint/buy/activation transaction manager."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from config import BROKER_ADDRESS, CHAIN_ID, RPC_URL

ACTOR_COUNT = 888
MINT_QTY = 2
ACTIVATION_BURN = 36_750 * 10**18
SCRIPT_DIR = Path(__file__).resolve().parent


def write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def initial_state(w3) -> dict:
    actors = []
    for index in range(ACTOR_COUNT):
        account = w3.eth.account.create()
        actors.append({
            "index": index,
            "address": account.address,
            "privateKey": account.key.hex(),
            "funded": False,
            "tokenIds": [],
            "coatBought": False,
            "approved": False,
            "activated": [],
        })
    return {"schema": "coattail-testnet-load-v1", "chainId": CHAIN_ID, "actors": actors, "receipts": []}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--init", action="store_true")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--max-actions", type=int, default=25)
    parser.add_argument("--state", type=Path, default=SCRIPT_DIR / "testnet-load-state.json")
    args = parser.parse_args()
    if CHAIN_ID != 46630:
        raise RuntimeError("testnet load is restricted to chain 46630")
    if args.max_actions < 1:
        raise RuntimeError("--max-actions must be positive")

    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    if not w3.is_connected() or w3.eth.chain_id != 46630:
        raise RuntimeError("RPC unavailable or wrong chain")
    if args.init:
        if args.state.exists():
            raise RuntimeError("state already exists; refusing to overwrite actor keys")
        write_state(args.state, initial_state(w3))
        print(f"created {ACTOR_COUNT} actors in {args.state}; keep this file secret")
        return
    if not args.state.exists():
        raise RuntimeError("initialize actors first with --init")
    if not args.execute:
        raise RuntimeError("use --execute to send the next resumable actions")

    coat_address = os.environ.get("COAT_ADDRESS", "")
    coat_router_address = os.environ.get("COAT_ROUTER_ADDRESS", "")
    funder_key = os.environ.get("LOAD_FUNDER_PRIVATE_KEY", "")
    if not BROKER_ADDRESS or not coat_address or not coat_router_address or not funder_key:
        raise RuntimeError("BROKER_ADDRESS, COAT_ADDRESS, COAT_ROUTER_ADDRESS and LOAD_FUNDER_PRIVATE_KEY are required")
    fund_amount = int(os.environ.get("TEST_ACTOR_ETH_WEI", "10000000000000000"))
    activation_buy_wei = int(os.environ.get("ACTIVATION_BUY_WEI", "1000000000000000"))
    max_retries = int(os.environ.get("TEST_TX_RETRIES", "2"))
    if max_retries < 0:
        raise RuntimeError("TEST_TX_RETRIES cannot be negative")

    broker = w3.eth.contract(address=Web3.to_checksum_address(BROKER_ADDRESS), abi=[
        {"type": "function", "name": "mintOpen", "stateMutability": "view", "inputs": [],
         "outputs": [{"name": "", "type": "bool"}]},
        {"type": "function", "name": "MINT_PRICE", "stateMutability": "view", "inputs": [],
         "outputs": [{"name": "", "type": "uint256"}]},
        {"type": "function", "name": "mint", "stateMutability": "payable",
         "inputs": [{"name": "qty", "type": "uint256"}],
         "outputs": [{"name": "tokenIds", "type": "uint256[]"}]},
        {"type": "function", "name": "activate", "stateMutability": "nonpayable",
         "inputs": [{"name": "tokenId", "type": "uint256"}], "outputs": []},
        {"type": "event", "name": "Minted", "anonymous": False,
         "inputs": [{"name": "to", "type": "address", "indexed": True},
                    {"name": "tokenId", "type": "uint256", "indexed": True},
                    {"name": "account", "type": "address", "indexed": False},
                    {"name": "paidWei", "type": "uint256", "indexed": False}]},
    ])
    coat = w3.eth.contract(address=Web3.to_checksum_address(coat_address), abi=[
        {"type": "function", "name": "approve", "stateMutability": "nonpayable",
         "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
         "outputs": [{"name": "", "type": "bool"}]},
    ])
    coat_router = w3.eth.contract(address=Web3.to_checksum_address(coat_router_address), abi=[
        {"type": "function", "name": "buy", "stateMutability": "payable",
         "inputs": [{"name": "minCoatOut", "type": "uint256"}, {"name": "to", "type": "address"}],
         "outputs": [{"name": "out", "type": "uint256"}]},
    ])
    if not broker.functions.mintOpen().call():
        raise RuntimeError("mint is closed; release owner must open it only after wiring verification")
    mint_price = int(broker.functions.MINT_PRICE().call())
    funder = w3.eth.account.from_key(funder_key)
    state = json.loads(args.state.read_text())
    if len(state.get("actors", [])) != ACTOR_COUNT:
        raise RuntimeError("actor state count mismatch")

    def send(account, transaction: dict, stage: str, actor_index: int):
        transaction.update({
            "from": account.address,
            "nonce": w3.eth.get_transaction_count(account.address, "pending"),
            "chainId": 46630,
        })
        # Build complete, explicitly priced transactions so both plain funding
        # transfers and contract calls can be signed by offline actor keys.
        transaction.setdefault("gas", int(w3.eth.estimate_gas(transaction) * 12 // 10))
        transaction.setdefault("gasPrice", w3.eth.gas_price)
        signed = account.sign_transaction(transaction)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        tx_hash = Web3.keccak(raw)
        receipt = None
        last_error = None
        used_attempt = 0
        for attempt in range(max_retries + 1):
            used_attempt = attempt
            try:
                w3.eth.send_raw_transaction(raw)
            except Exception as exc:  # rebroadcast can legitimately report "already known"
                last_error = exc
            try:
                receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
                break
            except Exception as exc:
                last_error = exc
        if receipt is None:
            state.setdefault("failures", []).append({
                "actor": actor_index,
                "stage": stage,
                "tx": tx_hash.hex(),
                "nonce": transaction["nonce"],
                "attempts": max_retries + 1,
                "error": str(last_error),
            })
            write_state(args.state, state)
            raise RuntimeError(f"{stage} receipt unavailable after retries: {tx_hash.hex()}")
        if receipt.status != 1:
            raise RuntimeError(f"{stage} receipt status {receipt.status}: {tx_hash.hex()}")
        state["receipts"].append({
            "actor": actor_index,
            "stage": stage,
            "tx": tx_hash.hex(),
            "block": receipt.blockNumber,
            "gasUsed": receipt.gasUsed,
            "nonce": transaction["nonce"],
            "status": receipt.status,
            "retries": used_attempt,
        })
        return receipt

    actions = 0
    for actor_state in state["actors"]:
        if actions >= args.max_actions:
            break
        index = int(actor_state["index"])
        actor = w3.eth.account.from_key(actor_state["privateKey"])
        if actor.address.lower() != actor_state["address"].lower():
            raise RuntimeError(f"actor {index} key/address mismatch")

        if not actor_state["funded"]:
            tx = {"to": actor.address, "value": fund_amount}
            send(funder, tx, "fund", index)
            actor_state["funded"] = True
        elif not actor_state["tokenIds"]:
            receipt = send(
                actor,
                broker.functions.mint(MINT_QTY).build_transaction({"value": mint_price * MINT_QTY}),
                "mint",
                index,
            )
            events = broker.events.Minted().process_receipt(receipt)
            ids = [int(event["args"]["tokenId"]) for event in events if event["args"]["to"] == actor.address]
            if len(ids) != MINT_QTY or len(set(ids)) != MINT_QTY or any(not 1 <= token_id <= 1776 for token_id in ids):
                raise RuntimeError(f"actor {index} invalid random mint receipt: {ids}")
            used = {token_id for row in state["actors"] for token_id in row.get("tokenIds", [])}
            if used.intersection(ids):
                raise RuntimeError(f"duplicate collection ID in actor {index} receipt")
            actor_state["tokenIds"] = ids
        elif not actor_state["coatBought"]:
            send(
                actor,
                coat_router.functions.buy(2 * ACTIVATION_BURN, actor.address)
                    .build_transaction({"value": activation_buy_wei}),
                "buy-coat",
                index,
            )
            actor_state["coatBought"] = True
        elif not actor_state["approved"]:
            send(
                actor,
                coat.functions.approve(broker.address, 2 * ACTIVATION_BURN).build_transaction(),
                "approve-coat",
                index,
            )
            actor_state["approved"] = True
        elif len(actor_state["activated"]) < MINT_QTY:
            token_id = actor_state["tokenIds"][len(actor_state["activated"])]
            send(actor, broker.functions.activate(token_id).build_transaction(), "activate", index)
            actor_state["activated"].append(token_id)
        else:
            continue
        actions += 1
        write_state(args.state, state)

    complete = sum(len(row["activated"]) == MINT_QTY for row in state["actors"])
    print(json.dumps({"actions": actions, "fullyActivatedActors": complete, "totalActors": ACTOR_COUNT}))


if __name__ == "__main__":
    main()
