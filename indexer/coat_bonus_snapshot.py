#!/usr/bin/env python3
"""Holder snapshot for a $COAT distribution, weighted toward active Brokers.

Reads the whole collection at one block — owner, ERC-6551 wallet and active flag of
every Broker — and allocates a fixed COAT amount by weight: an ACTIVE Broker gets
`--active-weight` shares delivered to its own wallet (the COAT travels with the NFT,
like salary), an inactive Broker gets `--inactive-weight` shares delivered either to
its owner's wallet (`--inactive-to owner`, so it can fund the activation burn, which
pulls from the owner) or to the Broker's own wallet (`--inactive-to wallet`, so the
COAT travels with the NFT exactly like the active tranche).

The total is either `--total-coat` (human units) or `--balance-of <sender>`: the
sender's exact COAT balance at the snapshot block, every wei of it allocated.

Outputs a recipients CSV for `scripts/distribute.sh` (address,amount; one row per
address, amounts summed) and a JSON report with the block, the counts and the per-share
figure, so the snapshot can be published before a single transfer is sent.

    python3 coat_bonus_snapshot.py --total-coat 64782405 --out reports/coat-bonus.csv
    python3 coat_bonus_snapshot.py --balance-of 0xSender --active-weight 0 --inactive-weight 1 \
        --inactive-to wallet --out reports/coat-bonus-t2.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import os
from collections import defaultdict
from datetime import datetime, timezone

WEI = 10**18

BROKER_ABI = [
    {"type": "function", "name": "totalMinted", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "ownerOf", "stateMutability": "view",
     "inputs": [{"name": "tokenId", "type": "uint256"}], "outputs": [{"name": "", "type": "address"}]},
    {"type": "function", "name": "accountOf", "stateMutability": "view",
     "inputs": [{"name": "tokenId", "type": "uint256"}], "outputs": [{"name": "", "type": "address"}]},
    {"type": "function", "name": "MAX_SUPPLY", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "coat", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "address"}]},
]
ERC20_ABI = [
    {"type": "function", "name": "balanceOf", "stateMutability": "view",
     "inputs": [{"name": "", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}]},
]
BOOSTER_ABI = [
    {"type": "function", "name": "isActive", "stateMutability": "view",
     "inputs": [{"name": "tokenId", "type": "uint256"}], "outputs": [{"name": "", "type": "bool"}]},
]


def coat_str(wei: int) -> str:
    """Exact decimal string for a wei amount (no float on the way: a float-formatted row
    can round up by a few hundred wei, and 567 such rows sum past the sender's balance)."""
    whole, frac = divmod(int(wei), WEI)
    text = f"{whole}.{frac:018d}".rstrip("0").rstrip(".")
    return text or "0"


def allocate(entries, total_wei, active_weight=2, inactive_weight=1, inactive_to="owner"):
    """Pure share math. `entries` are (token_id, active, owner, wallet).

    Returns (rows, per_share_wei) where rows is {address: wei}. Every wei of `total_wei`
    is assigned: integer division leaves a remainder, which goes to the first recipient
    so the CSV sums to exactly the amount being distributed. An inactive Broker's share
    goes to its owner (`inactive_to="owner"`) or to its own 6551 wallet ("wallet").
    """
    if inactive_to not in ("owner", "wallet"):
        raise ValueError("inactive_to must be 'owner' or 'wallet'")
    weights = []
    for token_id, active, owner, wallet in entries:
        w = active_weight if active else inactive_weight
        dest = wallet if (active or inactive_to == "wallet") else owner
        if w > 0:
            weights.append((token_id, dest, w))
    total_shares = sum(w for _, _, w in weights)
    if total_shares == 0:
        return {}, 0
    per_share = total_wei // total_shares
    rows: dict[str, int] = defaultdict(int)
    for _, dest, w in weights:
        rows[dest] += per_share * w
    remainder = total_wei - per_share * total_shares
    if remainder and weights:
        rows[weights[0][1]] += remainder
    return dict(rows), per_share


def read_collection(w3, broker_address, booster_address, chunk=150):
    from web3 import Web3
    from keeper import _mc_call

    broker = w3.eth.contract(address=Web3.to_checksum_address(broker_address), abi=BROKER_ABI)
    booster = w3.eth.contract(address=Web3.to_checksum_address(booster_address), abi=BOOSTER_ABI)
    minted = int(broker.functions.totalMinted().call())
    max_supply = int(broker.functions.MAX_SUPPLY().call())
    # The contract is not enumerable, but ids are drawn from 1..MAX_SUPPLY without
    # replacement, so every id in that range is either minted or reverts on ownerOf.
    ids = list(range(1, max_supply + 1))
    owners = _mc_call(w3, [(broker, "ownerOf", (i,)) for i in ids], chunk=chunk)
    minted_ids = [i for i, o in zip(ids, owners) if o is not None]
    if len(minted_ids) != minted:
        raise RuntimeError(f"read {len(minted_ids)} owners for {minted} minted Brokers; "
                           "refusing a partial snapshot (RPC fault?)")
    wallets = _mc_call(w3, [(broker, "accountOf", (i,)) for i in minted_ids], chunk=chunk)
    actives = _mc_call(w3, [(booster, "isActive", (i,)) for i in minted_ids], chunk=chunk)
    owner_of = dict(zip(ids, owners))
    entries = []
    for token_id, wallet, active in zip(minted_ids, wallets, actives):
        if wallet is None or active is None:
            raise RuntimeError(f"Broker #{token_id} could not be read; refusing a partial snapshot")
        entries.append((token_id, bool(active),
                        Web3.to_checksum_address(owner_of[token_id]),
                        Web3.to_checksum_address(wallet)))
    return entries


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--total-coat", type=float, help="COAT to distribute, human units")
    ap.add_argument("--balance-of", help="distribute this address's whole COAT balance at the snapshot block")
    ap.add_argument("--active-weight", type=int, default=2)
    ap.add_argument("--inactive-weight", type=int, default=1)
    ap.add_argument("--inactive-to", choices=("owner", "wallet"), default="owner",
                    help="where an inactive Broker's share lands (default: its owner's wallet)")
    ap.add_argument("--out", required=True, help="recipients CSV path (address,amount)")
    args = ap.parse_args()

    from config import make_web3, BOOSTER_ADDRESS
    broker_address = os.environ.get("BROKER_ADDRESS", "")
    if not broker_address or not BOOSTER_ADDRESS:
        raise SystemExit("set BROKER_ADDRESS and BOOSTER_ADDRESS")

    if (args.total_coat is None) == (args.balance_of is None):
        raise SystemExit("give exactly one of --total-coat or --balance-of")

    w3 = make_web3()
    block = w3.eth.block_number
    entries = read_collection(w3, broker_address, BOOSTER_ADDRESS)
    sender = None
    if args.balance_of:
        from web3 import Web3
        broker = w3.eth.contract(address=Web3.to_checksum_address(broker_address), abi=BROKER_ABI)
        coat = w3.eth.contract(address=broker.functions.coat().call(), abi=ERC20_ABI)
        sender = Web3.to_checksum_address(args.balance_of)
        total_wei = int(coat.functions.balanceOf(sender).call(block_identifier=block))
    else:
        total_wei = int(round(args.total_coat * WEI))
    rows, per_share = allocate(entries, total_wei, args.active_weight, args.inactive_weight, args.inactive_to)

    active_n = sum(1 for e in entries if e[1])
    with open(args.out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["address", "amount"])
        for addr, wei in sorted(rows.items(), key=lambda kv: -kv[1]):
            w.writerow([addr, coat_str(wei)])
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "block": block,
        "brokers": len(entries),
        "active": active_n,
        "inactive": len(entries) - active_n,
        "weights": {"active": args.active_weight, "inactive": args.inactive_weight},
        "inactiveTo": args.inactive_to,
        "sender": sender,
        "totalWei": str(total_wei),
        "totalCoat": total_wei / WEI,
        "perShareCoat": per_share / WEI,
        "activeBrokerCoat": per_share * args.active_weight / WEI,
        "inactiveBrokerCoat": per_share * args.inactive_weight / WEI,
        "recipients": len(rows),
        "sumCoat": sum(rows.values()) / WEI,
    }
    report_path = os.path.splitext(args.out)[0] + ".report.json"
    with open(report_path, "w") as fh:
        json.dump(report, fh, indent=2)
    print(json.dumps(report, indent=2))
    print(f"recipients -> {args.out}\nreport     -> {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
