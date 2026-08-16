#!/usr/bin/env python3
"""STATUS.md item 2 — live testnet transfer -> deactivation -> reactivation check.

Proves on the live chain that transferring one activated Broker deactivates only
that token and leaves every other token's accounting untouched, then that the new
owner can reactivate it with a fresh 36,750 COAT burn. The lifecycle logic is
already proven in contracts/test/Integration.t.sol; this runs the representative
demonstration against the deployed contracts and records a before/after report.

Requires a source key holding at least two activated Brokers and a new-owner key
funded with gas and >= 36,750 COAT for the reactivation burn:

    NETWORK=testnet \
    BROKER_ADDRESS=0x... BOOSTER_ADDRESS=0x... COAT_ADDRESS=0x... \
    SOURCE_PRIVATE_KEY=0x... NEW_OWNER_PRIVATE_KEY=0x... \
    TRANSFER_TOKEN_ID=487 RETAIN_TOKEN_ID=742 \
    python3 transfer_reactivation_check.py --execute
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import date
from pathlib import Path

from config import CHAIN_ID, RPC_URL

ACTIVATION_BURN = 36_750 * 10**18
SCRIPT_DIR = Path(__file__).resolve().parent
UA = {"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"}

BROKER_ABI = [
    {"type": "function", "name": "activated", "stateMutability": "view",
     "inputs": [{"type": "uint256"}], "outputs": [{"type": "bool"}]},
    {"type": "function", "name": "ownerOf", "stateMutability": "view",
     "inputs": [{"type": "uint256"}], "outputs": [{"type": "address"}]},
    {"type": "function", "name": "activate", "stateMutability": "nonpayable",
     "inputs": [{"name": "tokenId", "type": "uint256"}], "outputs": []},
    {"type": "function", "name": "transferFrom", "stateMutability": "nonpayable",
     "inputs": [{"name": "from", "type": "address"}, {"name": "to", "type": "address"},
                {"name": "tokenId", "type": "uint256"}], "outputs": []},
]
BOOSTER_ABI = [
    {"type": "function", "name": "isActive", "stateMutability": "view",
     "inputs": [{"type": "uint256"}], "outputs": [{"type": "bool"}]},
    {"type": "function", "name": "activeShares", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "pending", "stateMutability": "view",
     "inputs": [{"type": "uint256"}, {"type": "address"}], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "knownTokens", "stateMutability": "view",
     "inputs": [{"type": "uint256"}], "outputs": [{"type": "address"}]},
]
COAT_ABI = [
    {"type": "function", "name": "approve", "stateMutability": "nonpayable",
     "inputs": [{"type": "address"}, {"type": "uint256"}], "outputs": [{"type": "bool"}]},
    {"type": "function", "name": "balanceOf", "stateMutability": "view",
     "inputs": [{"type": "address"}], "outputs": [{"type": "uint256"}]},
]


def known_tokens(booster) -> list[str]:
    tokens, i = [], 0
    while True:
        try:
            tokens.append(booster.functions.knownTokens(i).call())
            i += 1
        except Exception:  # noqa: BLE001 - array out of bounds ends the list
            return tokens


def snapshot(broker, booster, token_id: int, tokens: list[str]) -> dict:
    return {
        "tokenId": token_id,
        "owner": broker.functions.ownerOf(token_id).call(),
        "activated": broker.functions.activated(token_id).call(),
        "isActive": booster.functions.isActive(token_id).call(),
        "pending": {t: booster.functions.pending(token_id, t).call() for t in tokens},
    }


def send(w3, account, fn):
    tx = fn.build_transaction({
        "from": account.address,
        "nonce": w3.eth.get_transaction_count(account.address, "pending"),
        "chainId": CHAIN_ID,
    })
    tx.setdefault("gas", int(w3.eth.estimate_gas(tx) * 12 // 10))
    tx.setdefault("gasPrice", w3.eth.gas_price)
    signed = account.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
    receipt = w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(raw), timeout=180)
    if receipt.status != 1:
        raise RuntimeError(f"tx failed: {receipt.transactionHash.hex()}")
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--out", type=Path,
                        default=SCRIPT_DIR / f"reports/transfer-reactivation-{date.today().isoformat()}.json")
    args = parser.parse_args()

    broker_addr = os.environ["BROKER_ADDRESS"]
    booster_addr = os.environ["BOOSTER_ADDRESS"]
    coat_addr = os.environ["COAT_ADDRESS"]
    transfer_id = int(os.environ["TRANSFER_TOKEN_ID"])
    retain_id = int(os.environ["RETAIN_TOKEN_ID"])

    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"headers": UA, "timeout": 60}))
    if not w3.is_connected() or w3.eth.chain_id != CHAIN_ID:
        raise RuntimeError("RPC unavailable or wrong chain")
    broker = w3.eth.contract(address=Web3.to_checksum_address(broker_addr), abi=BROKER_ABI)
    booster = w3.eth.contract(address=Web3.to_checksum_address(booster_addr), abi=BOOSTER_ABI)
    coat = w3.eth.contract(address=Web3.to_checksum_address(coat_addr), abi=COAT_ABI)
    tokens = known_tokens(booster)

    source = w3.eth.account.from_key(os.environ["SOURCE_PRIVATE_KEY"])
    new_owner = w3.eth.account.from_key(os.environ["NEW_OWNER_PRIVATE_KEY"])

    def state(label: str) -> dict:
        return {
            "label": label,
            "activeShares": booster.functions.activeShares().call(),
            "transfer": snapshot(broker, booster, transfer_id, tokens),
            "retain": snapshot(broker, booster, retain_id, tokens),
        }

    report = {"chainId": CHAIN_ID, "transferTokenId": transfer_id, "retainTokenId": retain_id,
              "knownTokens": tokens, "stages": [], "checks": {}, "ok": False}

    before = state("before")
    report["stages"].append(before)
    if not (before["transfer"]["activated"] and before["retain"]["activated"]):
        raise RuntimeError("both tokens must start activated for a representative check")
    if before["transfer"]["owner"].lower() != source.address.lower():
        raise RuntimeError("TRANSFER_TOKEN_ID is not owned by SOURCE_PRIVATE_KEY")

    if not args.execute:
        print(json.dumps({"dryRun": True, **{k: before[k] for k in ("activeShares",)}}))
        return

    # 1) Transfer one activated Broker -> auto-deactivates only that token.
    send(w3, source, broker.functions.transferFrom(source.address, new_owner.address, transfer_id))
    after_transfer = state("after-transfer")
    report["stages"].append(after_transfer)

    # 2) New owner reactivates it with a fresh 36,750 COAT burn.
    if coat.functions.balanceOf(new_owner.address).call() < ACTIVATION_BURN:
        raise RuntimeError("new owner needs >= 36,750 COAT for the reactivation burn")
    send(w3, new_owner, coat.functions.approve(booster_addr, ACTIVATION_BURN))
    send(w3, new_owner, broker.functions.activate(transfer_id))
    after_reactivate = state("after-reactivate")
    report["stages"].append(after_reactivate)

    checks = {
        "transfer_deactivated_on_transfer":
            after_transfer["transfer"]["activated"] is False and after_transfer["transfer"]["isActive"] is False,
        "activeShares_dropped_by_one":
            after_transfer["activeShares"] == before["activeShares"] - 1,
        "retain_untouched_by_transfer":
            after_transfer["retain"] == before["retain"],
        "transfer_entitlement_follows_token":
            after_transfer["transfer"]["pending"] == before["transfer"]["pending"] or
            all(v >= before["transfer"]["pending"][t] for t, v in after_transfer["transfer"]["pending"].items()),
        "transfer_reactivated":
            after_reactivate["transfer"]["activated"] is True and after_reactivate["transfer"]["isActive"] is True,
        "activeShares_restored":
            after_reactivate["activeShares"] == before["activeShares"],
        "retain_untouched_by_reactivate":
            after_reactivate["retain"]["activated"] == before["retain"]["activated"] and
            after_reactivate["retain"]["isActive"] == before["retain"]["isActive"],
    }
    report["checks"] = checks
    report["ok"] = all(checks.values())

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"ok": report["ok"], "checks": checks}))
    if not report["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
