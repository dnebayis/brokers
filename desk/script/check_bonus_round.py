#!/usr/bin/env python3
"""Bonus rounds, rehearsed end to end on an anvil fork of Robinhood Chain mainnet.

The mainnet deploy script is broadcast onto the fork (or DESK_ADDRESSES names a real deployment),
Desks are minted so the CoatBonusPool holds mint COAT, and then keeper/bonus_round.py is run
exactly as it will be run for real, as a subprocess, against the fork:

    snapshot (every Broker at one block, the active ones split the pool) -> verify -> post (the
    poster impersonated) -> verify (the chain accepts every pending claim) -> a tampered file is
    refused -> claim (batches) -> every active Broker's 6551 wallet gained its share, the
    inactive ones nothing, double claims and foreign leaves revert, a second claim run is a
    no-op -> a second round after more mints coexists with the first.

Nothing reaches a real network. Output: rehearsal/bonus-round-check.md.

    cd desk && FORK_RPC=<metered mainnet url> python3 script/check_bonus_round.py
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

os.environ.setdefault("DESK_NETWORK", "mainnet")
os.environ.setdefault("ANVIL_PORT", "8549")
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "keeper"))
import check_deployed as cd  # noqa: E402  (fork url, port, deploy_on_fork)
from rehearse_local import DESK, E18, ERC20, Fail, Run, abi  # noqa: E402
import bonus_round as br  # noqa: E402
from web3 import Web3  # noqa: E402

TOOL = DESK / "keeper" / "bonus_round.py"
ROUND0 = DESK / "rehearsal" / "bonus-round-fork-0.json"
ROUND1 = DESK / "rehearsal" / "bonus-round-fork-1.json"
TAMPERED = DESK / "rehearsal" / "bonus-round-fork-tampered.json"
REPORT = DESK / "rehearsal" / "bonus-round-check.md"
COAT_ROUTER = [{"type": "function", "name": "buy", "stateMutability": "payable",
                "inputs": [{"name": "minCoatOut", "type": "uint256"}, {"name": "to", "type": "address"}],
                "outputs": [{"type": "uint256"}]}]


def tool(addrs: Path, *args: str, expect: int = 0) -> str:
    env = dict(os.environ, RPC=cd.RPC)
    for k in ("KEEPER_KEY", "KEEPER_KEY_FILE", "RPC_ORIGIN"):  # impersonate on the fork; no Origin for anvil
        env.pop(k, None)
    p = subprocess.run([sys.executable, str(TOOL), "--addresses", str(addrs), *args], cwd=DESK, env=env,
                       capture_output=True, text=True)
    out = (p.stdout + p.stderr).strip()
    for line in out.splitlines():
        if "Warning" not in line and "warnings.warn" not in line:
            print("    | " + line)
    if p.returncode != expect:
        raise Fail(f"bonus_round.py {' '.join(args)} exited {p.returncode}, expected {expect}")
    return out


def main() -> int:
    anvil = subprocess.Popen(
        ["anvil", "--fork-url", cd.FORK_URL, "--port", str(cd.PORT), "--auto-impersonate", "--silent"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid,
    )
    try:
        w3 = Web3(Web3.HTTPProvider(cd.RPC, request_kwargs={"timeout": 600}))
        for _ in range(240):
            try:
                if w3.is_connected() and w3.eth.chain_id == 4663:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            print("anvil did not come up")
            return 1
        return check(w3)
    finally:
        os.killpg(os.getpgid(anvil.pid), signal.SIGTERM)


def check(w3: Web3) -> int:
    r = Run()
    t0 = time.time()
    fork_block = w3.eth.block_number
    if cd.DEPLOY_ON_FORK:
        print("step 0: the mainnet deploy script, broadcast on the fork")
        cd.deploy_on_fork()
    addrs = cd.ADDRS
    A = br.load_addresses(addrs)
    c = lambda a, x: w3.eth.contract(address=a, abi=x)  # noqa: E731
    coat = c(A["coat"], ERC20)
    desks = c(A["desks"], abi("DeskNFT"))
    pool = c(A["bonus"], br.POOL_ABI)
    brokers = c(A["brokers"], br.BROKERS_ABI)
    booster = c(A["booster"], br.BOOSTER_ABI)
    deployer = Web3.to_checksum_address(A["deployer"])
    poster = pool.functions.poster().call()
    for who in (deployer, poster):
        w3.provider.make_request("anvil_setBalance", [who, hex(10 * E18)])

    def send(sender: str, fn, what: str):
        w3.provider.make_request("anvil_impersonateAccount", [sender])
        h = w3.eth.send_transaction(fn.build_transaction({"from": sender, "gas": 15_000_000}))
        rc = w3.eth.wait_for_transaction_receipt(h)
        if rc.status != 1:
            raise Fail(f"tx reverted: {what}")
        r.log.append(("", what, h.hex(), rc.gasUsed))
        print(f"  tx {what}: gas {rc.gasUsed:,}")
        return rc

    def reverts(sender: str, fn) -> bool:
        try:
            fn.call({"from": sender})
            return False
        except Exception:
            return True

    print("step 1: Desks are minted, the pool fills with mint COAT")
    if not desks.functions.mintOpen().call():
        send(deployer, desks.functions.setMintOpen(True), "open the mint (fork only)")
    price = desks.functions.mintPrice().call()
    if coat.functions.balanceOf(deployer).call() < 4 * price:
        # mainnet has no faucet: buy the mint COAT through the live COAT router with fork ETH
        coat_router = c(A["coatRouter"], COAT_ROUTER)
        w3.provider.make_request("anvil_setBalance", [deployer, hex(20 * E18)])
        w3.provider.make_request("anvil_impersonateAccount", [deployer])
        h = w3.eth.send_transaction(coat_router.functions.buy(4 * price, deployer).build_transaction(
            {"from": deployer, "value": E18 // 4, "gas": 2_000_000}))
        if w3.eth.wait_for_transaction_receipt(h).status != 1:
            raise Fail("could not buy mint COAT on the fork")
        print(f"  tx buy {4 * price / E18:,.0f}+ COAT for the mints (fork ETH)")
    send(deployer, coat.functions.approve(A["desks"], 4 * price), "approve 4 mints")
    for i in range(3):
        send(deployer, desks.functions.mint(), f"mint Desk #{i + 1}")
    pot = coat.functions.balanceOf(A["bonus"]).call()
    r.check("1 mint", pot == 3 * price and pool.functions.unallocated().call() == pot,
            f"pool holds {pot / E18:,.0f} COAT, all of it unallocated")
    r.check("1 mint", pool.functions.roundCount().call() == 0, "no round yet")
    r.numbers["mint price (COAT)"] = f"{price / E18:,.0f}"

    print("step 2: snapshot")
    for f in (ROUND0, ROUND1, TAMPERED):
        f.unlink(missing_ok=True)
    tool(addrs, "snapshot", "--out", str(ROUND0.relative_to(DESK)))
    rnd = json.loads(ROUND0.read_text())
    active_n = booster.functions.activeShares().call()
    r.check("2 snapshot", rnd["activeBrokers"] == active_n == len(rnd["leaves"]),
            f"{active_n:,} active Brokers, one leaf each")
    r.check("2 snapshot", int(rnd["total"]) == int(rnd["perBroker"]) * active_n
            and int(rnd["total"]) + int(rnd["leftInPool"]) == pot,
            f"{rnd['totalCoat']} COAT = {rnd['perBrokerCoat']} x {active_n:,}; {br.coat_str(int(rnd['leftInPool']))} stays")
    ids = [x["tokenId"] for x in rnd["leaves"]]
    flags = br.Chain(w3, A).multicall(booster, "isActive", [(i,) for i in ids], block=rnd["snapshotBlock"])
    r.check("2 snapshot", all(flags), "every leaf is an active Broker at the snapshot block")
    accts = [Web3.to_checksum_address(a) for a in br.Chain(w3, A).multicall(brokers, "accountOf", [(i,) for i in ids])]
    r.check("2 snapshot", accts == [x["account"] for x in rnd["leaves"]],
            "every leaf names the Broker's own 6551 wallet")
    r.numbers["active Brokers"] = f"{active_n:,}"
    r.numbers["per Broker (COAT)"] = rnd["perBrokerCoat"]
    r.numbers["proof depth"] = str(max(len(x["proof"]) for x in rnd["leaves"]))

    print("step 3: verify before posting")
    tool(addrs, "verify", str(ROUND0.relative_to(DESK)))
    r.check("3 verify", True, "root, proofs, total and pool balance check out locally")

    print("step 4: post (poster impersonated)")
    tool(addrs, "post", str(ROUND0.relative_to(DESK)), "--dry-run")
    tool(addrs, "post", str(ROUND0.relative_to(DESK)))
    rnd = json.loads(ROUND0.read_text())
    rid = rnd["posted"]["roundId"]
    root, total, claimed = pool.functions.rounds(rid).call()
    r.check("4 post", rid == 0 and br.hx(bytes(root)) == rnd["root"] and total == int(rnd["total"]) and claimed == 0,
            f"round {rid} posted with the file's root and total")
    r.check("4 post", pool.functions.outstanding().call() == total
            and pool.functions.unallocated().call() == int(rnd["leftInPool"]),
            "outstanding = the round, unallocated = the remainder")
    tool(addrs, "post", str(ROUND0.relative_to(DESK)))  # idempotent
    r.check("4 post", pool.functions.roundCount().call() == 1, "posting the same file again sends nothing")
    r.check("4 post", reverts(deployer, pool.functions.postRound(bytes(root), 1)), "a non-poster cannot post")

    print("step 5: the chain accepts every pending claim; a tampered file is refused")
    tool(addrs, "verify", str(ROUND0.relative_to(DESK)))
    bad = json.loads(ROUND0.read_text())
    bad["leaves"][0]["amount"] = str(int(bad["leaves"][0]["amount"]) + 1)
    TAMPERED.write_text(json.dumps(bad))
    tool(addrs, "verify", str(TAMPERED.relative_to(DESK)), expect=1)
    out = tool(addrs, "claim", str(TAMPERED.relative_to(DESK)), "--dry-run", expect=1)
    r.check("5 verify", "refuses" in out and "nothing sent" in out, "a leaf with a changed amount is refused before anything is sent")

    print("step 6: claims land in the Broker wallets")
    before = br.Chain(w3, A).multicall(coat, "balanceOf", [(a,) for a in accts])
    inactive = next(i for i in range(1, brokers.functions.totalMinted().call() + 1) if i not in set(ids))
    inactive_acct = brokers.functions.accountOf(inactive).call()
    inactive_before = coat.functions.balanceOf(inactive_acct).call()
    tool(addrs, "claim", str(ROUND0.relative_to(DESK)), "--dry-run")
    tool(addrs, "claim", str(ROUND0.relative_to(DESK)), "--batch", "60")
    rnd = json.loads(ROUND0.read_text())
    after = br.Chain(w3, A).multicall(coat, "balanceOf", [(a,) for a in accts])
    per = int(rnd["perBroker"])
    r.check("6 claim", all(b - a == per for a, b in zip(before, after)),
            f"all {active_n:,} active Broker wallets gained exactly {rnd['perBrokerCoat']} COAT")
    r.check("6 claim", coat.functions.balanceOf(inactive_acct).call() == inactive_before,
            f"inactive Broker #{inactive} got nothing")
    _, total, claimed = pool.functions.rounds(rid).call()
    r.check("6 claim", claimed == total and pool.functions.outstanding().call() == 0
            and coat.functions.balanceOf(A["bonus"]).call() == int(rnd["leftInPool"]),
            "round fully claimed; only the remainder is left in the pool")
    first = rnd["leaves"][0]
    r.check("6 claim", reverts(deployer, pool.functions.claimMany(
        rid, [first["tokenId"]], [int(first["amount"])], [[br.unhex(p) for p in first["proof"]]])), "a double claim reverts")
    r.check("6 claim", reverts(deployer, pool.functions.claimMany(
        rid, [inactive], [per], [[br.unhex(p) for p in first["proof"]]])), "a claim for a Broker outside the tree reverts")
    tool(addrs, "claim", str(ROUND0.relative_to(DESK)))
    r.check("6 claim", len(rnd["claims"]) == -(-active_n // 60), f"{len(rnd['claims'])} batches; a second claim run sends nothing")
    receipts = [w3.eth.get_transaction_receipt(x["tx"]) for x in rnd["claims"]]
    r.numbers["claim batches"] = str(len(rnd["claims"]))
    r.numbers["claim gas, all batches"] = f"{sum(rc.gasUsed for rc in receipts):,}"
    r.numbers["claim gas per Broker"] = f"{sum(rc.gasUsed for rc in receipts) // active_n:,}"

    print("step 7: a second round after another mint")
    send(deployer, desks.functions.mint(), "mint Desk #4")
    tool(addrs, "snapshot", "--out", str(ROUND1.relative_to(DESK)))
    tool(addrs, "post", str(ROUND1.relative_to(DESK)))
    tool(addrs, "claim", str(ROUND1.relative_to(DESK)))
    rnd1 = json.loads(ROUND1.read_text())
    r.check("7 round 2", rnd1["posted"]["roundId"] == 1 and pool.functions.roundCount().call() == 2,
            "round 1 posted next to round 0")
    r.check("7 round 2", int(rnd1["total"]) + int(rnd1["leftInPool"]) == price + int(rnd["leftInPool"]),
            f"round 1 paid the new mint plus round 0's remainder ({rnd1['totalCoat']} COAT)")
    r.check("7 round 2", pool.functions.outstanding().call() == 0
            and coat.functions.balanceOf(A["bonus"]).call() == int(rnd1["leftInPool"]), "both rounds fully claimed")
    tool(addrs, "status")

    r.numbers["wall time"] = f"{time.time() - t0:.0f}s"
    _report(r, fork_block, A)
    print(f"\nall {len(r.checks)} checks passed; report -> {REPORT}")
    return 0


def _report(r: Run, fork_block: int, A: dict) -> None:
    lines = [
        "# Bonus rounds, rehearsed on a mainnet fork",
        "",
        f"_{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}, anvil fork of Robinhood Chain 4663 at block "
        f"{fork_block:,}; `script/check_bonus_round.py`. Nothing was sent to a real network._",
        "",
        f"Pool `{A['bonus']}`, Brokers `{A['brokers']}`, Booster `{A['booster']}`.",
        "",
        "| step | check |", "|---|---|",
    ]
    lines += [f"| {s} | {w} |" for s, w in r.checks]
    lines += ["", "| number | value |", "|---|---|"]
    lines += [f"| {k} | {v} |" for k, v in r.numbers.items()]
    lines += ["", "## Transactions (fork)", "", "| what | gas |", "|---|---|"]
    lines += [f"| {w} | {g:,} |" for _, w, _, g in r.log]
    REPORT.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fail as e:
        print(f"\nFAIL: {e}")
        sys.exit(1)
