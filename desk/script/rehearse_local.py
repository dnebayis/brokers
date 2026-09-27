#!/usr/bin/env python3
"""Desk build order step 5, local rehearsal: the full testnet flow on an anvil fork of 46630.

Starts anvil forked from Robinhood Chain testnet, runs script/DeployDeskTestnet.s.sol as the
testnet deployer (impersonated, fork only), then drives every user flow with real
transactions and checks each result on chain:

    mint -> deposit (USDG, ETH, COAT) -> buy -> rebalance -> fee split -> bonus round -> withdraw
    -> desk sale

Nothing reaches the real testnet. Two fresh throwaway wallets play the buyer (alice) and the
second-hand buyer (bob). Output: rehearsal/local-rehearsal.md (step log + numbers).

    cd desk && python3 script/rehearse_local.py
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

warnings.filterwarnings("ignore")
from eth_account import Account  # noqa: E402
from web3 import Web3  # noqa: E402

DESK = Path(__file__).resolve().parents[1]
FORK_URL = os.environ.get("TESTNET_RPC", "https://rpc.testnet.chain.robinhood.com")
PORT = int(os.environ.get("ANVIL_PORT", "8547"))
RPC = f"http://127.0.0.1:{PORT}"
DEPLOYER = Web3.to_checksum_address("0x9e643731dc9D8795573Aa34C410664407FfDC440")
E18, E6 = 10**18, 10**6

ERC20 = [
    {"type": "function", "name": n, "stateMutability": m, "inputs": i, "outputs": o}
    for n, m, i, o in [
        ("balanceOf", "view", [{"name": "a", "type": "address"}], [{"type": "uint256"}]),
        ("transfer", "nonpayable", [{"name": "to", "type": "address"}, {"name": "v", "type": "uint256"}],
         [{"type": "bool"}]),
        ("approve", "nonpayable", [{"name": "s", "type": "address"}, {"name": "v", "type": "uint256"}],
         [{"type": "bool"}]),
        ("mint", "nonpayable", [{"name": "to", "type": "address"}, {"name": "v", "type": "uint256"}], []),
    ]
]
BROKER = [
    {"type": "function", "name": "mint", "stateMutability": "payable",
     "inputs": [{"name": "qty", "type": "uint256"}], "outputs": [{"type": "uint256[]"}]},
    {"type": "function", "name": "activate", "stateMutability": "nonpayable",
     "inputs": [{"name": "id", "type": "uint256"}], "outputs": []},
    {"type": "function", "name": "mintPriceWei", "stateMutability": "view", "inputs": [],
     "outputs": [{"type": "uint256"}]},
    {"type": "function", "name": "accountOf", "stateMutability": "view",
     "inputs": [{"name": "id", "type": "uint256"}], "outputs": [{"type": "address"}]},
    {"type": "event", "name": "Transfer", "anonymous": False, "inputs": [
        {"name": "from", "type": "address", "indexed": True},
        {"name": "to", "type": "address", "indexed": True},
        {"name": "tokenId", "type": "uint256", "indexed": True}]},
]
BOOSTER = [{"type": "function", "name": "isActive", "stateMutability": "view",
            "inputs": [{"name": "id", "type": "uint256"}], "outputs": [{"type": "bool"}]},
           {"type": "function", "name": "stockFeed", "stateMutability": "view",
            "inputs": [{"name": "t", "type": "address"}], "outputs": [{"type": "address"}]}]
FEED = [{"type": "function", "name": "latestRoundData", "stateMutability": "view", "inputs": [],
         "outputs": [{"type": "uint80"}, {"type": "int256"}, {"type": "uint256"}, {"type": "uint256"},
                     {"type": "uint80"}]}]
REGISTRY = [
    {"type": "function", "name": "setStrategy", "stateMutability": "nonpayable",
     "inputs": [{"name": "id", "type": "uint256"}, {"name": "t", "type": "address[]"},
                {"name": "w", "type": "uint16[]"}], "outputs": []},
    {"type": "function", "name": "getBasket", "stateMutability": "view",
     "inputs": [{"name": "id", "type": "uint256"}],
     "outputs": [{"type": "address[]"}, {"type": "uint16[]"}, {"type": "uint64"}]},
]


def abi(name: str, source: str | None = None) -> list:
    src = source or name
    return json.loads((DESK / "out" / f"{src}.sol" / f"{name}.json").read_text())["abi"]


def _raw(signed) -> bytes:
    # eth-account renamed rawTransaction -> raw_transaction; accept both
    return getattr(signed, "raw_transaction", None) or signed.rawTransaction


def _events(event, receipt):
    fn = getattr(event, "process_receipt", None) or event.processReceipt  # web3 6 beta naming
    return fn(receipt)


class Fail(Exception):
    pass


class Run:
    def __init__(self) -> None:
        self.log: list[tuple[str, str, str, int]] = []  # step, what, tx, gas
        self.checks: list[tuple[str, str]] = []
        self.numbers: dict[str, str] = {}

    def check(self, step: str, ok: bool, what: str) -> None:
        self.checks.append((step, ("PASS " if ok else "FAIL ") + what))
        print(f"  [{'ok' if ok else 'FAIL'}] {what}")
        if not ok:
            raise Fail(f"{step}: {what}")


def main() -> int:
    anvil = subprocess.Popen(
        ["anvil", "--fork-url", FORK_URL, "--port", str(PORT), "--auto-impersonate", "--silent"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid,
    )
    try:
        w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 120}))
        for _ in range(120):
            try:
                if w3.is_connected() and w3.eth.chain_id == 46630:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            print("anvil did not come up")
            return 1
        return rehearse(w3)
    finally:
        os.killpg(os.getpgid(anvil.pid), signal.SIGTERM)


def rehearse(w3: Web3) -> int:
    r = Run()
    fork_block = w3.eth.block_number
    alice, bob, treasury = Account.create(), Account.create(), Account.create()
    for who in (DEPLOYER, alice.address, bob.address):
        w3.provider.make_request("anvil_setBalance", [who, hex(10 * E18)])

    def send(sender, fn, value: int = 0, step: str = "", what: str = ""):
        if isinstance(sender, str):  # deployer: impersonated on the fork
            tx = fn.build_transaction({"from": sender, "value": value, "gas": 15_000_000})
            h = w3.eth.send_transaction(tx)
        else:
            tx = fn.build_transaction({
                "from": sender.address, "value": value, "gas": 15_000_000,
                "nonce": w3.eth.get_transaction_count(sender.address), "chainId": 46630,
            })
            h = w3.eth.send_raw_transaction(_raw(sender.sign_transaction(tx)))
        rc = w3.eth.wait_for_transaction_receipt(h)
        if rc.status != 1:
            raise Fail(f"{step}: tx reverted: {what}")
        r.log.append((step, what, h.hex(), rc.gasUsed))
        print(f"  tx {what}: gas {rc.gasUsed:,}")
        return rc

    def reverts(sender: str, fn) -> bool:
        try:
            fn.call({"from": sender})
            return False
        except Exception:
            return True

    # ---------- deploy ----------
    print("step 1: deploy (forge script as the testnet deployer)")
    out = DESK / "rehearsal" / "rehearsal-fork-addresses.json"  # never the lab's file
    env = dict(os.environ, DESK_TREASURY=treasury.address, DESK_OUT=str(out.relative_to(DESK)))
    p = subprocess.run(
        ["forge", "script", "script/DeployDeskTestnet.s.sol", "--rpc-url", RPC, "--broadcast",
         "--unlocked", "--sender", DEPLOYER, "--slow"],
        cwd=DESK, env=env, capture_output=True, text=True,
    )
    if p.returncode != 0:
        print(p.stdout[-3000:], p.stderr[-3000:])
        return 1
    A = {k: (Web3.to_checksum_address(v) if isinstance(v, str) and v.startswith("0x") else v)
         for k, v in json.loads(out.read_text()).items()}
    bc = json.loads((DESK / "broadcast" / "DeployDeskTestnet.s.sol" / "46630" / "run-latest.json").read_text())
    deploy_txs = len(bc["transactions"])
    deploy_gas = sum(int(x["gasUsed"], 16) for x in bc["receipts"])
    r.log.append(("1 deploy", f"{deploy_txs} deployer transactions", "(broadcast/run-latest.json)", deploy_gas))
    print(f"  {deploy_txs} txs, gas {deploy_gas:,}")

    c = lambda addr, a: w3.eth.contract(address=addr, abi=a)  # noqa: E731
    coat, usdg = c(A["coat"], ERC20), c(A["usdg"], ERC20)
    taapl, tmsft, weth = c(A["taapl"], ERC20), c(A["tmsft"], ERC20), c(A["weth"], ERC20)
    brokers, booster, registry = c(A["brokers"], BROKER), c(A["booster"], BOOSTER), c(A["registry"], REGISTRY)
    desks, engine = c(A["desks"], abi("DeskNFT")), c(A["engine"], abi("DeskEngine"))
    renderer, bonus = c(A["renderer"], abi("DeskRenderer")), c(A["bonus"], abi("CoatBonusPool"))
    eth_pool = c(A["ethPool"], abi("DeskTestPool", "DeskTestVenue"))
    acct_abi = abi("DeskAccount")
    sid = int(A["strategyId"])

    r.check("1 deploy", renderer.functions.frozen().call(), "traits uploaded and frozen against the commit")
    r.check("1 deploy", desks.functions.mintOpen().call(), "desk mint open")
    r.check("1 deploy", engine.functions.feeBps().call() == 50 and engine.functions.pilotCapUsdg().call() == 1000 * E6,
            "engine at pilot parameters (0.5% fee, $1,000 cap)")
    toks, wts, ep = registry.functions.getBasket(sid).call()
    r.check("1 deploy", toks == [A["taapl"]] and list(wts) == [10000],
            f"desk strategy slot {sid} holds tAAPL 100% (epoch {ep}); Booster slot 0 untouched")

    # ---------- fund the actors (what a user would buy on the market) ----------
    mint_price = desks.functions.mintPrice().call()
    send(DEPLOYER, coat.functions.transfer(alice.address, mint_price + 2 * 36_750 * E18 + 10_000 * E18), step="setup",
         what="deployer sends alice COAT for a desk mint and two broker activations")
    send(DEPLOYER, usdg.functions.mint(alice.address, 1_500 * E6), step="setup", what="alice gets 1,500 test USDG")

    # ---------- brokers for the bonus round ----------
    print("step 2: two active Brokers (bonus round recipients)")
    rc = send(alice, brokers.functions.mint(2), value=2 * brokers.functions.mintPriceWei().call(),
              step="2 brokers", what="alice mints 2 Brokers")
    ids = [e.args.tokenId for e in _events(brokers.events.Transfer(), rc) if e.args["from"] == "0x" + "0" * 40]
    send(alice, coat.functions.approve(A["brokers"], 2 * 36_750 * E18), step="2 brokers", what="approve activation burn")
    for i in ids:
        send(alice, brokers.functions.activate(i), step="2 brokers", what=f"activate Broker #{i}")
    r.check("2 brokers", all(booster.functions.isActive(i).call() for i in ids), f"Brokers {ids} active in the Booster")

    # ---------- mint ----------
    print("step 3: mint a Desk")
    send(alice, coat.functions.approve(A["desks"], mint_price), step="3 mint", what="approve mint price")
    bonus_before = coat.functions.balanceOf(A["bonus"]).call()
    rc = send(alice, desks.functions.mint(), step="3 mint", what="alice mints a Desk")
    ev = _events(desks.events.DeskMinted(), rc)[0].args
    desk_id, acct_addr = ev.tokenId, Web3.to_checksum_address(ev.account)
    acct = c(acct_addr, acct_abi)
    r.check("3 mint", desks.functions.ownerOf(desk_id).call() == alice.address, f"Desk #{desk_id} owned by alice")
    r.check("3 mint", len(w3.eth.get_code(acct_addr)) > 0, f"Desk wallet deployed at mint ({acct_addr})")
    r.check("3 mint", coat.functions.balanceOf(A["bonus"]).call() - bonus_before == mint_price,
            f"{mint_price // E18:,} COAT went to the bonus pool, none burned")
    uri = desks.functions.tokenURI(desk_id).call()
    r.check("3 mint", uri.startswith("data:application/json;base64,"), "tokenURI renders on chain")

    # ---------- deposit ----------
    print("step 4: deposit (USDG, ETH, COAT) through the router, capped at $1,000 put in")
    router = c(A["depositRouter"], abi("DeskDepositRouter"))
    send(alice, usdg.functions.approve(A["depositRouter"], 1_500 * E6), step="4 deposit", what="approve USDG deposit")
    send(alice, router.functions.depositUsdg(desk_id, 900 * E6), step="4 deposit", what="alice deposits 900 USDG")
    before = usdg.functions.balanceOf(acct_addr).call()
    floor_eth = router.functions.minUsdgForEth(E18 // 100).call()
    send(alice, router.functions.depositEth(desk_id, 0), value=E18 // 100, step="4 deposit",
         what="alice deposits 0.01 ETH through the deposit router")
    eth_in = usdg.functions.balanceOf(acct_addr).call() - before
    r.check("4 deposit", eth_in >= floor_eth, f"0.01 ETH arrived as {eth_in / E6:.2f} USDG (Chainlink floor {floor_eth / E6:.2f})")
    send(alice, coat.functions.approve(A["depositRouter"], 10_000 * E18), step="4 deposit", what="approve COAT deposit")
    before = usdg.functions.balanceOf(acct_addr).call()
    send(alice, router.functions.depositCoat(desk_id, 10_000 * E18, 1, 0), step="4 deposit",
         what="alice deposits 10,000 COAT (COAT -> ETH on the live testnet v4 pool -> USDG)")
    coat_in = usdg.functions.balanceOf(acct_addr).call() - before
    r.check("4 deposit", coat_in > 0, f"10,000 COAT arrived as {coat_in / E6:.4f} USDG (thin testnet COAT pool)")
    principal = engine.functions.principalOf(desk_id).call()
    room = engine.functions.depositRoomOf(desk_id).call()
    r.check("4 deposit", principal == 900 * E6 + eth_in + coat_in and room == 1_000 * E6 - principal,
            f"principal ${principal / E6:,.2f} booked, ${room / E6:,.2f} of room left under the $1,000 pilot cap")
    r.check("4 deposit", reverts(alice.address, router.functions.depositUsdg(desk_id, room + E6)),
            "a deposit over the pilot cap reverts")
    send(alice, usdg.functions.transfer(acct_addr, 200 * E6), step="4 deposit",
         what="alice sends 200 USDG straight to the wallet, around the router")
    r.check("4 deposit", engine.functions.investableOf(desk_id).call() == principal,
            "USDG sent around the router is not booked, so it is never invested")
    r.check("4 deposit", w3.eth.get_balance(A["depositRouter"]) == 0 and usdg.functions.balanceOf(A["depositRouter"]).call() == 0
            and coat.functions.balanceOf(A["depositRouter"]).call() == 0, "deposit router holds nothing afterwards")

    # ---------- buy ----------
    print("step 5: buy the basket")
    floor = engine.functions.minStockOut(A["taapl"], principal * 995 // 1000).call()
    send(DEPLOYER, engine.functions.buyBasket(desk_id, 10_000 * E6), step="5 buy", what="keeper buyBasket")
    got = taapl.functions.balanceOf(acct_addr).call()
    oracle_amt = floor * 10_000 // 9_500
    r.check("5 buy", usdg.functions.balanceOf(acct_addr).call() == 200 * E6,
            "every booked dollar went to work; the 200 sent around the router still sits idle")
    r.check("5 buy", got >= floor, f"tAAPL fill above the Chainlink floor ({got / oracle_amt * 10_000:.0f} bps of oracle)")
    r.check("5 buy", engine.functions.principalOf(desk_id).call() == principal, "buying does not move the principal")
    r.check("5 buy", reverts(DEPLOYER, engine.functions.buyBasket(desk_id, 100 * E6)), "nothing booked left to buy with")
    r.numbers["buy fill vs oracle (bps)"] = f"{got / oracle_amt * 10_000:.0f}"

    # ---------- rebalance ----------
    print("step 6: rebalance on an epoch change (tAAPL 100 -> tAAPL 70 / tMSFT 30)")
    feed_px = lambda t: w3.eth.contract(address=booster.functions.stockFeed(t).call(), abi=FEED).functions.latestRoundData().call()[1] / 1e8  # noqa: E731
    pa, pm = feed_px(A["taapl"]), feed_px(A["tmsft"])
    v_before = _desk_value(taapl, tmsft, usdg, acct_addr, pa, pm)
    send(DEPLOYER, registry.functions.setStrategy(sid, [A["taapl"], A["tmsft"]], [7000, 3000]),
         step="6 rebalance", what="new basket posted (epoch +1)")
    fees_before = engine.functions.feesAccrued().call()
    # targeted: sell only the 30% that moves, buy only the new name with the proceeds
    idle = usdg.functions.balanceOf(acct_addr).call()
    send(DEPLOYER, engine.functions.sellStock(desk_id, A["taapl"], got * 3 // 10), step="6 rebalance",
         what="keeper sells 30% of the tAAPL")
    proceeds = usdg.functions.balanceOf(acct_addr).call() - idle
    send(DEPLOYER, engine.functions.buyStock(desk_id, A["tmsft"], proceeds), step="6 rebalance",
         what="keeper buyStock tMSFT with the proceeds")
    r.check("6 rebalance", usdg.functions.balanceOf(acct_addr).call() == idle, "the unbooked idle USDG was not touched")
    r.check("6 rebalance", reverts(DEPLOYER, engine.functions.buyStock(desk_id, A["weth"], 1)),
            "buyStock refuses a name outside the basket")
    a_val = taapl.functions.balanceOf(acct_addr).call() * pa / E18
    m_val = tmsft.functions.balanceOf(acct_addr).call() * pm / E18
    v_after = _desk_value(taapl, tmsft, usdg, acct_addr, pa, pm)
    reb_fees = (engine.functions.feesAccrued().call() - fees_before) / E6
    r.check("6 rebalance", abs(a_val / (a_val + m_val) - 0.70) < 0.005,
            f"stock split {a_val / (a_val + m_val):.1%} tAAPL / {m_val / (a_val + m_val):.1%} tMSFT")
    r.check("6 rebalance", engine.functions.principalOf(desk_id).call() == principal, "a rebalance never moves the principal")
    r.numbers["rebalance cost (USD)"] = f"{v_before - v_after:.2f} of {v_before:.2f} ({(v_before - v_after) / v_before:.2%})"
    r.numbers["rebalance engine fees (USD)"] = f"{reb_fees:.2f}"

    # ---------- fee split ----------
    print("step 7: fee flush and 80/20 split")
    fees = engine.functions.feesAccrued().call()
    quote = eth_pool.functions.quote(A["usdg"], fees).call()
    b0, t0 = w3.eth.get_balance(A["booster"]), w3.eth.get_balance(treasury.address)
    send(DEPLOYER, engine.functions.flushFees(quote * 99 // 100), step="7 fee split", what="keeper flushFees")
    to_b, to_t = w3.eth.get_balance(A["booster"]) - b0, w3.eth.get_balance(treasury.address) - t0
    r.check("7 fee split", to_b + to_t == quote, f"{fees / E6:.2f} USDG -> {quote / E18:.6f} native ETH")
    r.check("7 fee split", to_b == quote * 8000 // 10_000, f"Booster got {to_b / E18:.6f} ETH (80%), treasury {to_t / E18:.6f} ETH")
    r.check("7 fee split", usdg.functions.balanceOf(A["engine"]).call() == 0 and weth.functions.balanceOf(A["engine"]).call() == 0,
            "engine keeps no USDG or WETH")

    # ---------- bonus round ----------
    print("step 8: bonus round (mint COAT -> active Brokers)")
    total = coat.functions.balanceOf(A["bonus"]).call()
    amts = [total // 2, total - total // 2]
    leaves = [Web3.keccak(Web3.keccak(w3.codec.encode(["uint256", "uint256"], [i, a]))) for i, a in zip(ids, amts)]
    root = Web3.keccak(b"".join(sorted(leaves)))
    send(DEPLOYER, bonus.functions.postRound(root, total), step="8 bonus", what="poster posts round 0")
    accts = [brokers.functions.accountOf(i).call() for i in ids]
    before = [coat.functions.balanceOf(a).call() for a in accts]
    send(bob, bonus.functions.claim(0, ids[0], amts[0], [leaves[1]]), step="8 bonus",
         what=f"bob claims for Broker #{ids[0]} (permissionless)")
    send(alice, bonus.functions.claimMany(0, [ids[1]], [amts[1]], [[leaves[0]]]), step="8 bonus",
         what=f"alice claims for Broker #{ids[1]}")
    gained = [coat.functions.balanceOf(a).call() - b for a, b in zip(accts, before)]
    r.check("8 bonus", gained == amts, f"each Broker wallet got {amts[0] / E18:,.0f} COAT (paid to the NFT, not the caller)")
    r.check("8 bonus", bonus.functions.outstanding().call() == 0 and coat.functions.balanceOf(A["bonus"]).call() == 0,
            "round fully paid, pool empty")
    r.check("8 bonus", reverts(bob.address, bonus.functions.claim(0, ids[0], amts[0], [leaves[1]])), "double claim reverts")

    # ---------- withdraw ----------
    print("step 9: owner withdraws from the Desk wallet")
    m_bal = tmsft.functions.balanceOf(acct_addr).call()
    u_bal = usdg.functions.balanceOf(acct_addr).call()
    send(alice, acct.functions.execute(A["tmsft"], 0, tmsft.encodeABI("transfer", [alice.address, m_bal]), 0),
         step="9 withdraw", what="alice pulls tMSFT out")
    if u_bal:
        send(alice, acct.functions.execute(A["usdg"], 0, usdg.encodeABI("transfer", [alice.address, u_bal]), 0),
             step="9 withdraw", what="alice pulls leftover USDG out")
    p_after = engine.functions.principalOf(desk_id).call()
    r.check("9 withdraw", p_after < principal,
            f"withdrawals lowered the principal from ${principal / E6:,.2f} to ${p_after / E6:,.2f}, reopening room")
    r.check("9 withdraw", tmsft.functions.balanceOf(alice.address).call() == m_bal and
            tmsft.functions.balanceOf(acct_addr).call() == 0, f"{m_bal / E18:.4f} tMSFT now in alice's wallet")
    r.check("9 withdraw", reverts(bob.address, acct.functions.execute(A["taapl"], 0,
            taapl.encodeABI("transfer", [bob.address, 1]), 0)), "a stranger cannot move Desk assets")

    # ---------- desk sale ----------
    print("step 10: Desk sale (alice -> bob), assets travel with the NFT")
    a_left = taapl.functions.balanceOf(acct_addr).call()
    tx = {"from": bob.address, "to": alice.address, "value": E18 // 100, "gas": 21000,
          "nonce": w3.eth.get_transaction_count(bob.address), "chainId": 46630,
          "gasPrice": w3.eth.gas_price}
    h = w3.eth.send_raw_transaction(_raw(bob.sign_transaction(tx)))
    w3.eth.wait_for_transaction_receipt(h)
    r.log.append(("10 sale", "bob pays alice 0.01 ETH (off-market sale stand-in)", h.hex(), 21000))
    send(alice, desks.functions.transferFrom(alice.address, bob.address, desk_id), step="10 sale",
         what=f"alice transfers Desk #{desk_id} to bob")
    magic = bytes.fromhex("523e3260")  # IERC6551Account.isValidSigner selector
    r.check("10 sale", desks.functions.ownerOf(desk_id).call() == bob.address, "bob owns the Desk")
    r.check("10 sale", taapl.functions.balanceOf(acct_addr).call() == a_left, f"{a_left / E18:.4f} tAAPL stayed in the Desk wallet")
    r.check("10 sale", acct.functions.isValidSigner(bob.address, b"").call() == magic and
            acct.functions.isValidSigner(alice.address, b"").call() != magic, "control moved: bob signs, alice cannot")
    r.check("10 sale", reverts(alice.address, acct.functions.execute(A["taapl"], 0,
            taapl.encodeABI("transfer", [alice.address, 1]), 0)), "alice can no longer withdraw")
    send(bob, acct.functions.setEnginePaused(True), step="10 sale", what="bob pauses the engine on his Desk")
    send(DEPLOYER, usdg.functions.mint(bob.address, 50 * E6), step="10 sale", what="(test) bob gets 50 USDG")
    send(bob, usdg.functions.approve(A["depositRouter"], 50 * E6), step="10 sale", what="approve")
    send(bob, router.functions.depositUsdg(desk_id, 50 * E6), step="10 sale", what="bob deposits 50 USDG into his Desk")
    r.check("10 sale", engine.functions.investableOf(desk_id).call() >= 50 * E6, "the deposit is booked")
    r.check("10 sale", reverts(DEPLOYER, engine.functions.buyBasket(desk_id, 50 * E6)), "engine cannot pull while bob has it paused")
    send(bob, acct.functions.execute(A["taapl"], 0, taapl.encodeABI("transfer", [bob.address, a_left]), 0),
         step="10 sale", what="bob withdraws the tAAPL he bought with the Desk")
    r.check("10 sale", taapl.functions.balanceOf(bob.address).call() == a_left, "bob holds the Desk's tAAPL")
    uri = desks.functions.tokenURI(desk_id).call()
    r.check("10 sale", uri.startswith("data:application/json;base64,"), "tokenURI still renders after the sale")

    _report(r, fork_block, A, desk_id, ids)
    print(f"\nALL {len(r.checks)} CHECKS PASSED, {len(r.log)} logged transactions")
    return 0


def _desk_value(taapl, tmsft, usdg, acct, pa: float, pm: float) -> float:
    return (taapl.functions.balanceOf(acct).call() * pa / E18 + tmsft.functions.balanceOf(acct).call() * pm / E18
            + usdg.functions.balanceOf(acct).call() / E6)


def _report(r: Run, fork_block: int, A: dict, desk_id: int, ids: list) -> None:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "# The Desk: local testnet rehearsal (build order step 5, dress run)",
        "",
        f"Run {now} on an anvil fork of Robinhood Chain testnet (46630) at block {fork_block:,}.",
        "Nothing was sent to the real testnet. Deployer transactions were impersonated on the fork;",
        "alice and bob were fresh throwaway wallets. Re-run: `cd desk && python3 script/rehearse_local.py`.",
        "",
        "Test venue (testnet has no USDG and no v3 USDG pools): test USDG, tMSFT, and oracle-priced",
        "pools filling at feed price minus 0.30%. The tAAPL staging feed was refreshed to $200, tMSFT",
        "feed $500, ETH feed $2,700. The Desk uses its own strategy slot; Booster slot 0 untouched.",
        "",
        f"Desk #{desk_id}, bonus Brokers {ids}.",
        "",
        "## Checks",
        "",
    ]
    lines += [f"- step {s}: {w}" for s, w in r.checks]
    lines += ["", "## Numbers", ""] + [f"- {k}: {v}" for k, v in r.numbers.items()]
    lines += ["", "## Transactions", "", "| step | what | gas |", "|---|---|---|"]
    lines += [f"| {s} | {w} | {g:,} |" for s, w, _, g in r.log]
    lines += ["", "## Addresses (fork only, not deployed anywhere)", ""]
    lines += [f"- {k}: `{v}`" for k, v in A.items()]
    (DESK / "rehearsal" / "local-rehearsal.md").write_text("\n".join(lines) + "\n")
    print("report -> rehearsal/local-rehearsal.md")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fail as e:
        print(f"\nREHEARSAL FAILED: {e}")
        sys.exit(1)
