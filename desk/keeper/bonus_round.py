#!/usr/bin/env python3
"""Bonus rounds: the COAT the Desk mint collects, paid to the Brokers that are active.

Every Desk mint sends its price to the CoatBonusPool. The pool pays it out in merkle rounds:
one root per round, one leaf per active Broker, claims land in the Broker's own 6551 wallet
(the bonus follows the NFT, like salary). This tool is the whole flow, in the order it runs:

    snapshot  read every Broker at one block (owner, wallet, Booster.isActive), split the pool's
              unallocated COAT equally over the active ones, build the tree, write the round file
    verify    recompute the root from the round file, check every proof locally and, once the
              round is posted, ask the chain (static claimMany) that every leaf would be paid
    post      postRound(root, total) from the pool's poster (the keeper relay)
    claim     claimMany in batches for every leaf not yet claimed (permissionless; any funded key)
    status    pool balance, unallocated, outstanding, every round's claimed/total

The round file (desk/rounds/round-<n>.json) is committed before the root is posted, so any
round is reproducible from public state: the block, the active set and the per-Broker amount
are all in it. Anything not divisible stays unallocated in the pool for the next round.

Signing: KEEPER_KEY or KEEPER_KEY_FILE (a json with a "key" field), as desk_keeper.py. Without
a key the tool only runs against a local fork (127.0.0.1), impersonating the poster / deployer.
The metered endpoint needs RPC_ORIGIN, as the keepers do.

    cd desk && RPC=<mainnet rpc> python3 keeper/bonus_round.py snapshot --out rounds/round-0.json
    cd desk && RPC=<mainnet rpc> KEEPER_KEY_FILE=... python3 keeper/bonus_round.py post rounds/round-0.json
    cd desk && RPC=<mainnet rpc> KEEPER_KEY_FILE=... python3 keeper/bonus_round.py claim rounds/round-0.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

warnings.filterwarnings("ignore")
from eth_abi import encode as abi_encode  # noqa: E402
from eth_account import Account  # noqa: E402
from web3 import Web3  # noqa: E402

DESK = Path(__file__).resolve().parents[1]
E18 = 10**18
ZERO = "0x0000000000000000000000000000000000000000"
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
MULTICALL_ABI = [{"type": "function", "name": "aggregate3", "stateMutability": "payable",
                  "inputs": [{"name": "calls", "type": "tuple[]", "components": [
                      {"name": "target", "type": "address"}, {"name": "allowFailure", "type": "bool"},
                      {"name": "callData", "type": "bytes"}]}],
                  "outputs": [{"name": "r", "type": "tuple[]", "components": [
                      {"name": "success", "type": "bool"}, {"name": "returnData", "type": "bytes"}]}]}]
BROKERS_ABI = [
    {"type": "function", "name": "totalMinted", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "MAX_SUPPLY", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "ownerOf", "stateMutability": "view",
     "inputs": [{"name": "tokenId", "type": "uint256"}], "outputs": [{"type": "address"}]},
    {"type": "function", "name": "accountOf", "stateMutability": "view",
     "inputs": [{"name": "tokenId", "type": "uint256"}], "outputs": [{"type": "address"}]},
]
BOOSTER_ABI = [{"type": "function", "name": "isActive", "stateMutability": "view",
                "inputs": [{"name": "tokenId", "type": "uint256"}], "outputs": [{"type": "bool"}]},
               {"type": "function", "name": "activeShares", "stateMutability": "view", "inputs": [],
                "outputs": [{"type": "uint256"}]}]
ERC20_ABI = [{"type": "function", "name": "balanceOf", "stateMutability": "view",
              "inputs": [{"name": "a", "type": "address"}], "outputs": [{"type": "uint256"}]}]
POOL_ABI = [
    {"type": "function", "name": "poster", "stateMutability": "view", "inputs": [], "outputs": [{"type": "address"}]},
    {"type": "function", "name": "outstanding", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "unallocated", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "roundCount", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "rounds", "stateMutability": "view", "inputs": [{"name": "i", "type": "uint256"}],
     "outputs": [{"name": "root", "type": "bytes32"}, {"name": "total", "type": "uint96"},
                 {"name": "claimed", "type": "uint96"}]},
    {"type": "function", "name": "isClaimed", "stateMutability": "view",
     "inputs": [{"name": "roundId", "type": "uint256"}, {"name": "tokenId", "type": "uint256"}],
     "outputs": [{"type": "bool"}]},
    {"type": "function", "name": "postRound", "stateMutability": "nonpayable",
     "inputs": [{"name": "root", "type": "bytes32"}, {"name": "total", "type": "uint256"}],
     "outputs": [{"name": "roundId", "type": "uint256"}]},
    {"type": "function", "name": "claimMany", "stateMutability": "nonpayable",
     "inputs": [{"name": "roundId", "type": "uint256"}, {"name": "tokenIds", "type": "uint256[]"},
                {"name": "amounts", "type": "uint256[]"}, {"name": "proofs", "type": "bytes32[][]"}],
     "outputs": []},
    {"type": "event", "name": "RoundPosted", "anonymous": False, "inputs": [
        {"name": "roundId", "type": "uint256", "indexed": True}, {"name": "root", "type": "bytes32", "indexed": False},
        {"name": "total", "type": "uint256", "indexed": False}]},
]


# ---------- merkle (OpenZeppelin MerkleProof: sorted-pair hashing, double-hashed leaves) ----------

def leaf_hash(token_id: int, amount: int) -> bytes:
    return Web3.keccak(Web3.keccak(abi_encode(["uint256", "uint256"], [token_id, amount])))


def hash_pair(a: bytes, b: bytes) -> bytes:
    return Web3.keccak(a + b) if a < b else Web3.keccak(b + a)


def build_tree(leaves: list[bytes]) -> tuple[bytes, dict[bytes, list[bytes]]]:
    """Root and one proof per leaf. Leaves are sorted, paired level by level; an unpaired node is
    carried up unchanged (its proof simply has one element less). MerkleProof.verify folds the
    proof with the same commutative pair hash, so any such tree verifies on chain."""
    if not leaves:
        raise ValueError("no leaves")
    if len(set(leaves)) != len(leaves):
        raise ValueError("duplicate leaf")
    level = sorted(leaves)
    proofs: dict[bytes, list[bytes]] = {leaf: [] for leaf in level}
    members: list[list[bytes]] = [[leaf] for leaf in level]  # leaves under each node of the level
    while len(level) > 1:
        nxt, nxt_members = [], []
        for i in range(0, len(level), 2):
            if i + 1 == len(level):  # odd one out: carried up, no sibling at this level
                nxt.append(level[i])
                nxt_members.append(members[i])
                continue
            a, b = level[i], level[i + 1]
            for leaf in members[i]:
                proofs[leaf].append(b)
            for leaf in members[i + 1]:
                proofs[leaf].append(a)
            nxt.append(hash_pair(a, b))
            nxt_members.append(members[i] + members[i + 1])
        level, members = nxt, nxt_members
    return level[0], proofs


def verify_proof(root: bytes, leaf: bytes, proof: list[bytes]) -> bool:
    node = leaf
    for sib in proof:
        node = hash_pair(node, sib)
    return node == root


# ---------- chain plumbing ----------

def hx(b: bytes) -> str:
    return "0x" + b.hex()


def unhex(s: str) -> bytes:
    return bytes.fromhex(s[2:] if s.startswith("0x") else s)


def calldata(contract, fn: str, args: list) -> bytes:
    """ABI-encode a call; web3 6 spells it encodeABI, web3 7 encode_abi."""
    if hasattr(contract, "encode_abi"):
        try:
            return unhex(contract.encode_abi(fn, args=args))
        except TypeError:
            return unhex(contract.encode_abi(abi_element_identifier=fn, args=args))
    return unhex(contract.encodeABI(fn_name=fn, args=args))


def connect() -> Web3:
    rpc = os.environ.get("RPC", "http://127.0.0.1:8545")
    kwargs: dict = {"timeout": 60}
    if os.environ.get("RPC_ORIGIN") and "127.0.0.1" not in rpc and "localhost" not in rpc:
        kwargs["headers"] = {"Origin": os.environ["RPC_ORIGIN"]}  # anvil refuses a request carrying one
    w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs=kwargs))
    try:  # a plain read instead of is_connected(): web3 6 asks web3_clientVersion, which anvil refuses
        w3.eth.chain_id
    except Exception as e:
        raise SystemExit(f"cannot reach {rpc}: {str(e)[:120]}")
    return w3


def is_local(w3: Web3) -> bool:
    rpc = str(w3.provider.endpoint_uri)
    return "127.0.0.1" in rpc or "localhost" in rpc


def load_addresses(path: Path) -> dict:
    A = json.loads(path.read_text())
    return {k: (Web3.to_checksum_address(v) if isinstance(v, str) and v.startswith("0x") and len(v) == 42 else v)
            for k, v in A.items()}


class Chain:
    def __init__(self, w3: Web3, A: dict):
        self.w3, self.A = w3, A
        c = lambda a, x: w3.eth.contract(address=Web3.to_checksum_address(a), abi=x)  # noqa: E731
        self.brokers = c(A["brokers"], BROKERS_ABI)
        self.booster = c(A["booster"], BOOSTER_ABI)
        self.coat = c(A["coat"], ERC20_ABI)
        self.pool = c(A["bonus"], POOL_ABI) if A.get("bonus") and A["bonus"] != ZERO else None
        self.mc = c(MULTICALL3, MULTICALL_ABI)
        self.signer = None
        key = os.environ.get("KEEPER_KEY")
        if not key and os.environ.get("KEEPER_KEY_FILE"):
            key = json.loads(Path(os.environ["KEEPER_KEY_FILE"]).read_text())["key"]
        if key:
            self.signer = Account.from_key(key)

    # many view calls at one block, failures as None
    def multicall(self, contract, fn: str, args_list: list[tuple], block=None, chunk: int = 200) -> list:
        out: list = []
        entry = next(a for a in contract.abi if a.get("type") == "function" and a["name"] == fn)
        types = [o["type"] for o in entry["outputs"]]
        for i in range(0, len(args_list), chunk):
            part = args_list[i:i + chunk]
            calls = [(contract.address, True, calldata(contract, fn, list(a))) for a in part]
            kw = {"block_identifier": block} if block is not None else {}
            res = self.mc.functions.aggregate3(calls).call(**kw)
            from eth_abi import decode as abi_decode
            for ok, data in res:
                if not ok or not data:
                    out.append(None)
                    continue
                vals = abi_decode(types, bytes(data))
                out.append(vals[0] if len(vals) == 1 else vals)
        return out

    def sender_for(self, must_be: str | None, role: str) -> str:
        """The address that signs: the configured key, or an impersonated account on a local fork."""
        if self.signer:
            if must_be and self.signer.address != must_be:
                raise SystemExit(f"the configured key is {self.signer.address}, but the {role} is {must_be}")
            return self.signer.address
        if not is_local(self.w3):
            raise SystemExit(f"no KEEPER_KEY: without a key the {role} can only be impersonated on a local fork")
        who = must_be or Web3.to_checksum_address(self.A["deployer"])
        self.w3.provider.make_request("anvil_impersonateAccount", [who])
        self.w3.provider.make_request("anvil_setBalance", [who, hex(10 * E18)])
        return who

    def send(self, sender: str, fn, what: str):
        w3 = self.w3
        if self.signer:
            # the relay key is shared with the Booster and Desk keepers: nonce as they take it
            nonce = max(w3.eth.get_transaction_count(sender, "pending"), w3.eth.get_transaction_count(sender, "latest"))
            tx = fn.build_transaction({"from": sender, "nonce": nonce, "chainId": w3.eth.chain_id})
            signed = self.signer.sign_transaction(tx)
            h = w3.eth.send_raw_transaction(getattr(signed, "raw_transaction", None) or signed.rawTransaction)
        else:
            h = w3.eth.send_transaction(fn.build_transaction({"from": sender, "gas": 15_000_000}))
        rc = w3.eth.wait_for_transaction_receipt(h, timeout=180, poll_latency=1)
        ok = rc.status == 1
        print(f"  {'tx' if ok else 'REVERTED'} {what}: {Web3.to_hex(h)} (gas {rc.gasUsed:,})", flush=True)
        if not ok:
            raise SystemExit(f"{what}: transaction reverted")
        return rc


# ---------- the round file ----------

def save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1) + "\n")


def load_round(path: Path) -> dict:
    return json.loads(path.read_text())


def leaves_of(rnd: dict) -> list[tuple[int, int, bytes, list[bytes]]]:
    return [(int(x["tokenId"]), int(x["amount"]), leaf_hash(int(x["tokenId"]), int(x["amount"])),
             [unhex(p) for p in x["proof"]]) for x in rnd["leaves"]]


def coat_str(wei: int) -> str:
    whole, frac = divmod(int(wei), E18)
    s = f"{whole}.{frac:018d}".rstrip("0").rstrip(".")
    return s or "0"


# ---------- commands ----------

def cmd_snapshot(ch: Chain, args) -> int:
    w3 = ch.w3
    block = args.block or w3.eth.block_number
    print(f"snapshot at block {block:,} on chain {w3.eth.chain_id}")
    max_supply = ch.brokers.functions.MAX_SUPPLY().call(block_identifier=block)
    minted = ch.brokers.functions.totalMinted().call(block_identifier=block)
    ids = list(range(1, max_supply + 1))
    owners = ch.multicall(ch.brokers, "ownerOf", [(i,) for i in ids], block=block)
    minted_ids = [i for i, o in zip(ids, owners) if o is not None]
    if len(minted_ids) != minted:
        raise SystemExit(f"read {len(minted_ids)} owners for {minted} minted Brokers: refusing a partial snapshot")
    actives = ch.multicall(ch.booster, "isActive", [(i,) for i in minted_ids], block=block)
    if any(a is None for a in actives):
        raise SystemExit("an isActive read failed: refusing a partial snapshot")
    active_ids = [i for i, a in zip(minted_ids, actives) if a]
    shares = ch.booster.functions.activeShares().call(block_identifier=block)
    if len(active_ids) != shares:
        raise SystemExit(f"{len(active_ids)} active flags but activeShares is {shares}: the read straddled a change, retry")
    accounts = ch.multicall(ch.brokers, "accountOf", [(i,) for i in active_ids], block=block)
    if any(a is None for a in accounts):
        raise SystemExit("an accountOf read failed: refusing a partial snapshot")
    accounts = [Web3.to_checksum_address(a) for a in accounts]
    if not active_ids:
        raise SystemExit("no active Broker at that block")

    pool_balance = unallocated = None
    if ch.pool is not None and w3.eth.get_code(ch.pool.address, block_identifier=block):
        pool_balance = ch.coat.functions.balanceOf(ch.pool.address).call(block_identifier=block)
        unallocated = ch.pool.functions.unallocated().call(block_identifier=block)
    if args.total_coat is not None:
        from decimal import Decimal
        total_in = int(Decimal(args.total_coat) * E18)
    elif unallocated is not None:
        total_in = unallocated
    else:
        raise SystemExit("no bonus pool at that block: give --total-coat")
    if unallocated is not None and total_in > unallocated:
        raise SystemExit(f"{coat_str(total_in)} COAT asked, only {coat_str(unallocated)} unallocated in the pool")
    per = total_in // len(active_ids)
    if per == 0:
        raise SystemExit("nothing to pay: the pool's unallocated COAT does not cover one wei per active Broker")
    total = per * len(active_ids)

    leaf_list = [leaf_hash(i, per) for i in active_ids]
    root, proofs = build_tree(leaf_list)
    ts = w3.eth.get_block(block)["timestamp"]
    rnd = {
        "chainId": w3.eth.chain_id,
        "bonus": ch.A.get("bonus"),
        "brokers": ch.A["brokers"],
        "booster": ch.A["booster"],
        "coat": ch.A["coat"],
        "snapshotBlock": block,
        "snapshotTime": datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds"),
        "brokersMinted": minted,
        "activeBrokers": len(active_ids),
        "poolBalance": str(pool_balance) if pool_balance is not None else None,
        "unallocated": str(unallocated) if unallocated is not None else None,
        "perBroker": str(per),
        "perBrokerCoat": coat_str(per),
        "total": str(total),
        "totalCoat": coat_str(total),
        "leftInPool": str(total_in - total),
        "root": hx(root),
        "leaves": [{"tokenId": i, "account": a, "amount": str(per), "proof": [hx(p) for p in proofs[leaf]]}
                   for i, a, leaf in zip(active_ids, accounts, leaf_list)],
        "posted": None,
        "claims": [],
    }
    out = Path(args.out)
    save(out, rnd)
    depth = max(len(x["proof"]) for x in rnd["leaves"])
    print(f"  {minted:,} Brokers minted, {len(active_ids):,} active")
    print(f"  {coat_str(total)} COAT over {len(active_ids):,} active Brokers = {coat_str(per)} COAT each"
          + (f"; {coat_str(total_in - total)} COAT stays unallocated" if total_in - total else ""))
    print(f"  root {hx(root)} (proof depth {depth})")
    print(f"  -> {out}")
    return 0


def _find_round(ch: Chain, root: bytes) -> int | None:
    n = ch.pool.functions.roundCount().call()
    for i in range(n):
        r, _, _ = ch.pool.functions.rounds(i).call()
        if bytes(r) == root:
            return i
    return None


def _static_claims(ch: Chain, round_id: int, items: list[tuple[int, int, bytes, list[bytes]]]) -> list[bool]:
    """Ask the node, without sending, whether each single claim would succeed (state is discarded)."""
    calls = [(ch.pool.address, True, calldata(ch.pool, "claimMany", [round_id, [i], [amt], [proof]]))
             for i, amt, _, proof in items]
    oks: list[bool] = []
    for s in range(0, len(calls), 100):
        res = ch.mc.functions.aggregate3(calls[s:s + 100]).call()
        oks.extend(bool(ok) for ok, _ in res)
    return oks


def cmd_verify(ch: Chain, args) -> int:
    rnd = load_round(Path(args.file))
    items = leaves_of(rnd)
    root = unhex(rnd["root"])
    rebuilt, _ = build_tree([leaf for _, _, leaf, _ in items])
    ok_root = rebuilt == root
    ok_proofs = all(verify_proof(root, leaf, proof) for _, _, leaf, proof in items)
    ok_total = sum(amt for _, amt, _, _ in items) == int(rnd["total"])
    ok_ids = len({i for i, _, _, _ in items}) == len(items)
    print(f"round file {args.file}: {len(items):,} leaves, {rnd['totalCoat']} COAT, {rnd['perBrokerCoat']} each")
    print(f"  [{'ok' if ok_root else 'FAIL'}] root rebuilt from the leaves matches {rnd['root']}")
    print(f"  [{'ok' if ok_proofs else 'FAIL'}] every proof verifies locally")
    print(f"  [{'ok' if ok_total else 'FAIL'}] amounts sum to the total")
    print(f"  [{'ok' if ok_ids else 'FAIL'}] no Broker twice")
    all_ok = ok_root and ok_proofs and ok_total and ok_ids
    if ch.pool is None or not ch.w3.eth.get_code(ch.pool.address):
        print("  (no bonus pool on this chain yet: on-chain checks skipped)")
        return 0 if all_ok else 1
    rid = _find_round(ch, root)
    if rid is None:
        free = ch.pool.functions.unallocated().call()
        fits = int(rnd["total"]) <= free
        print(f"  [{'ok' if fits else 'FAIL'}] not posted yet; the pool holds {coat_str(free)} COAT unallocated"
              f" {'>=' if fits else '<'} the round's {rnd['totalCoat']}")
        return 0 if all_ok and fits else 1
    r_root, r_total, r_claimed = ch.pool.functions.rounds(rid).call()
    print(f"  posted as round {rid}: total {coat_str(r_total)} COAT, claimed {coat_str(r_claimed)}")
    claimed = ch.multicall(ch.pool, "isClaimed", [(rid, i) for i, _, _, _ in items])
    pending = [it for it, c in zip(items, claimed) if not c]
    print(f"  {len(items) - len(pending):,} claimed, {len(pending):,} pending")
    if pending:
        oks = _static_claims(ch, rid, pending)
        bad = [it[0] for it, ok in zip(pending, oks) if not ok]
        print(f"  [{'ok' if not bad else 'FAIL'}] the chain accepts every pending claim"
              + (f" (refused: {bad[:10]}{'…' if len(bad) > 10 else ''})" if bad else ""))
        all_ok = all_ok and not bad
    return 0 if all_ok else 1


def cmd_post(ch: Chain, args) -> int:
    path = Path(args.file)
    rnd = load_round(path)
    if ch.pool is None:
        raise SystemExit("no bonus pool address")
    if rnd.get("chainId") != ch.w3.eth.chain_id:
        raise SystemExit(f"round file is for chain {rnd.get('chainId')}, rpc is chain {ch.w3.eth.chain_id}")
    if rnd.get("bonus") and Web3.to_checksum_address(rnd["bonus"]) != ch.pool.address:
        raise SystemExit("round file names a different bonus pool")
    root, total = unhex(rnd["root"]), int(rnd["total"])
    items = leaves_of(rnd)
    rebuilt, _ = build_tree([leaf for _, _, leaf, _ in items])
    if rebuilt != root or sum(a for _, a, _, _ in items) != total:
        raise SystemExit("round file does not verify (run `verify`)")
    if rnd.get("posted"):
        print(f"already posted as round {rnd['posted']['roundId']} in {rnd['posted']['tx']}")
        return 0
    existing = _find_round(ch, root)
    if existing is not None:
        print(f"this root is already round {existing} on chain; recording it")
        rnd["posted"] = {"roundId": existing, "tx": None, "block": None}
        save(path, rnd)
        return 0
    free = ch.pool.functions.unallocated().call()
    if total > free:
        raise SystemExit(f"the pool has {coat_str(free)} COAT unallocated, the round needs {coat_str(total)}")
    poster = ch.pool.functions.poster().call()
    print(f"post round: {rnd['totalCoat']} COAT to {rnd['activeBrokers']:,} active Brokers "
          f"({rnd['perBrokerCoat']} each), snapshot block {rnd['snapshotBlock']:,}, poster {poster}")
    if args.dry_run:
        data = hx(calldata(ch.pool, "postRound", [root, total]))
        print(f"  dry run: postRound calldata to {ch.pool.address}\n  {data}")
        return 0
    sender = ch.sender_for(poster, "poster")
    rc = ch.send(sender, ch.pool.functions.postRound(root, total), "postRound")
    rid = _find_round(ch, root)  # read back from the chain (event decoding differs across web3 versions)
    if rid is None:
        raise SystemExit("postRound succeeded but the root is not among the rounds; check the pool by hand")
    rnd["posted"] = {"roundId": rid, "tx": Web3.to_hex(rc.transactionHash), "block": rc.blockNumber,
                     "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    save(path, rnd)
    print(f"  round {rid} posted; file updated")
    return 0


def cmd_claim(ch: Chain, args) -> int:
    path = Path(args.file)
    rnd = load_round(path)
    if ch.pool is None:
        raise SystemExit("no bonus pool address")
    root = unhex(rnd["root"])
    rid = rnd["posted"]["roundId"] if rnd.get("posted") else _find_round(ch, root)
    if rid is None:
        raise SystemExit("round not posted yet (run `post`)")
    items = leaves_of(rnd)
    claimed = ch.multicall(ch.pool, "isClaimed", [(rid, i) for i, _, _, _ in items])
    pending = [it for it, c in zip(items, claimed) if not c]
    print(f"round {rid}: {len(items) - len(pending):,} of {len(items):,} claimed, {len(pending):,} to go")
    if not pending:
        return 0
    oks = _static_claims(ch, rid, pending)
    refused = [it[0] for it, ok in zip(pending, oks) if not ok]
    if refused:
        raise SystemExit(f"the chain refuses {len(refused)} claims (first: {refused[:10]}); nothing sent")
    if args.dry_run:
        print(f"  dry run: {len(pending):,} claims in {-(-len(pending) // args.batch)} batches of up to {args.batch}")
        return 0
    sender = ch.sender_for(None, "claimer")
    for s in range(0, len(pending), args.batch):
        part = pending[s:s + args.batch]
        fn = ch.pool.functions.claimMany(rid, [i for i, _, _, _ in part], [a for _, a, _, _ in part],
                                         [p for _, _, _, p in part])
        rc = ch.send(sender, fn, f"claimMany x{len(part)} (#{part[0][0]}..#{part[-1][0]})")
        rnd.setdefault("claims", []).append({"tx": Web3.to_hex(rc.transactionHash), "block": rc.blockNumber,
                                             "tokenIds": [i for i, _, _, _ in part]})
        save(path, rnd)
    _, r_total, r_claimed = ch.pool.functions.rounds(rid).call()
    print(f"  round {rid}: {coat_str(r_claimed)} of {coat_str(r_total)} COAT claimed")
    return 0


def cmd_status(ch: Chain, args) -> int:
    if ch.pool is None or not ch.w3.eth.get_code(ch.pool.address):
        print("no bonus pool on this chain")
        return 1
    bal = ch.coat.functions.balanceOf(ch.pool.address).call()
    print(f"bonus pool {ch.pool.address}")
    print(f"  COAT held       {coat_str(bal)}")
    print(f"  unallocated     {coat_str(ch.pool.functions.unallocated().call())}  (next round's pot)")
    print(f"  outstanding     {coat_str(ch.pool.functions.outstanding().call())}  (posted, not yet claimed)")
    print(f"  poster          {ch.pool.functions.poster().call()}")
    print(f"  active Brokers  {ch.booster.functions.activeShares().call():,}")
    n = ch.pool.functions.roundCount().call()
    for i in range(n):
        r, t, c = ch.pool.functions.rounds(i).call()
        print(f"  round {i}: {coat_str(c)} / {coat_str(t)} COAT claimed, root {hx(bytes(r))}")
    if n == 0:
        print("  no rounds yet")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--addresses", default=os.environ.get("DESK_ADDRESSES", "rehearsal/mainnet-4663.json"),
                    help="desk address file (brokers, booster, coat, bonus, deployer)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot", help="active Brokers at one block -> round file")
    s.add_argument("--block", type=int, help="pin the snapshot to this block (default: latest)")
    s.add_argument("--total-coat", help="COAT to pay out (default: everything unallocated in the pool)")
    s.add_argument("--out", required=True, help="round file to write, e.g. rounds/round-0.json")
    v = sub.add_parser("verify", help="check a round file locally and against the chain")
    v.add_argument("file")
    p = sub.add_parser("post", help="postRound from the poster")
    p.add_argument("file")
    p.add_argument("--dry-run", action="store_true")
    c = sub.add_parser("claim", help="claimMany for every unclaimed leaf")
    c.add_argument("file")
    c.add_argument("--batch", type=int, default=60)
    c.add_argument("--dry-run", action="store_true")
    sub.add_parser("status", help="pool and rounds")
    args = ap.parse_args()

    addr_path = Path(args.addresses)
    if not addr_path.is_absolute():
        addr_path = DESK / addr_path
    ch = Chain(connect(), load_addresses(addr_path))
    return {"snapshot": cmd_snapshot, "verify": cmd_verify, "post": cmd_post,
            "claim": cmd_claim, "status": cmd_status}[args.cmd](ch, args)


if __name__ == "__main__":
    sys.exit(main())
