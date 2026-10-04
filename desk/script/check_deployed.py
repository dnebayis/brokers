#!/usr/bin/env python3
"""Final check of a LIVE Desk deployment, on an anvil fork of its chain.

Unlike rehearse_local.py this deploys nothing: it forks the network at the current block and
drives the contracts that are already deployed (addresses from DESK_ADDRESSES), so what is
tested is the bytecode users will actually call. The keeper's own code makes the buys.

    mint -> deposit (USDG, ETH) -> cap refusal -> keeper buys -> owner's own shares stay
    untouched -> prices move (profit, room unchanged) -> withdrawal frees room by its value
    -> fill to the cap -> fee flush (Chainlink floor) -> desk sale

Nothing reaches the real network. Output: rehearsal/deployed-check.md.

    cd desk && DESK_ADDRESSES=rehearsal/testnet-46630-v3.json python3 script/check_deployed.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "keeper"))
from rehearse_local import DESK, E6, E18, ERC20, Fail, Run, _raw, abi  # noqa: E402
import rehearse_local  # noqa: E402
import desk_keeper  # noqa: E402
from eth_account import Account  # noqa: E402
from web3 import Web3  # noqa: E402

ADDRS = DESK / os.environ.get("DESK_ADDRESSES", "rehearsal/testnet-46630-v3.json")
FEED_W = desk_keeper.FEED  # latestRoundData, owner, setAnswer (test feeds)


def check(w3: Web3) -> int:
    r = Run()
    fork_block = w3.eth.block_number
    A = {k: (Web3.to_checksum_address(v) if isinstance(v, str) and v.startswith("0x") else v)
         for k, v in json.loads(ADDRS.read_text()).items()}
    c = lambda a, x: w3.eth.contract(address=a, abi=x)  # noqa: E731
    usdg, coat = c(A["usdg"], ERC20), c(A["coat"], ERC20)
    taapl, tmsft, tnvda = c(A["taapl"], ERC20), c(A["tmsft"], ERC20), c(A["tnvda"], ERC20)
    desks, engine = c(A["desks"], abi("DeskNFT")), c(A["engine"], abi("DeskEngine"))
    router, renderer = c(A["depositRouter"], abi("DeskDepositRouter")), c(A["renderer"], abi("DeskRenderer"))
    keeper_addr = engine.functions.keeper().call()
    deployer = Web3.to_checksum_address(A["deployer"])
    alice, bob = Account.create(), Account.create()
    for who in (deployer, keeper_addr, alice.address, bob.address):
        w3.provider.make_request("anvil_setBalance", [who, hex(10 * E18)])

    def send(sender, fn, value: int = 0, what: str = ""):
        if isinstance(sender, str):  # deployer or keeper, impersonated on the fork
            h = w3.eth.send_transaction(fn.build_transaction({"from": sender, "value": value, "gas": 15_000_000}))
        else:
            tx = fn.build_transaction({"from": sender.address, "value": value, "gas": 15_000_000,
                                       "nonce": w3.eth.get_transaction_count(sender.address), "chainId": w3.eth.chain_id})
            h = w3.eth.send_raw_transaction(_raw(sender.sign_transaction(tx)))
        rc = w3.eth.wait_for_transaction_receipt(h)
        if rc.status != 1:
            raise Fail(f"tx reverted: {what}")
        r.log.append(("", what, h.hex(), rc.gasUsed))
        print(f"  tx {what}: gas {rc.gasUsed:,}")
        return rc

    def reverts(sender: str, fn, value: int = 0) -> bool:
        try:
            fn.call({"from": sender, "value": value})
            return False
        except Exception:
            return True

    def px(token: str) -> float:
        return desk_keeper.Keeper.price(k, token)

    def value(acct: str) -> float:
        v = usdg.functions.balanceOf(acct).call() / E6
        for t in (taapl, tmsft, tnvda):
            v += t.functions.balanceOf(acct).call() / E18 * px(t.address)
        return v

    def managed(desk: int) -> float:
        """What the engine runs for the Desk: its booked USDG plus the shares it bought."""
        v = engine.functions.investableOf(desk).call() / E6
        for t in (taapl, tmsft, tnvda):
            v += engine.functions.heldQty(desk, t.address).call() / E18 * px(t.address)
        return v

    # the keeper's own code, impersonating the deployer (the engine owner may act as keeper)
    _, stocks, symbols = desk_keeper.load(ADDRS)
    k = desk_keeper.Keeper(w3, A, stocks, symbols)

    print("step 1: what is deployed")
    r.check("1 config", engine.functions.depositRouter().call() == A["depositRouter"]
            and router.functions.engine().call() == A["engine"], "engine and deposit router point at each other")
    r.check("1 config", c(A["accountImpl"], abi("DeskAccount")).functions.engine().call() == A["engine"],
            "every Desk wallet is bound to this engine")
    r.check("1 config", engine.functions.ethUsdFeed().call() == A["ethFeed"], "fee flush floored by Chainlink ETH/USD")
    r.check("1 config", engine.functions.pilotCapUsdg().call() == 1000 * E6 and engine.functions.feeBps().call() == 50,
            "pilot cap $1,000, fee 0.5%")
    r.check("1 config", renderer.functions.frozen().call() and desks.functions.mintOpen().call(),
            "traits frozen, mint open")

    print("step 2: alice mints a Desk")
    price = desks.functions.mintPrice().call()
    send(deployer, coat.functions.transfer(alice.address, price), what="alice gets the mint price in COAT")
    send(deployer, usdg.functions.mint(alice.address, 2_000 * E6), what="alice gets 2,000 test USDG")
    send(alice, coat.functions.approve(A["desks"], price), what="approve the mint price")
    pool_before = coat.functions.balanceOf(A["bonus"]).call()
    send(alice, desks.functions.mint(), what="alice mints a Desk")
    desk_id = desks.functions.totalMinted().call()
    acct = desks.functions.accountOf(desk_id).call()
    wallet = c(acct, abi("DeskAccount"))
    r.check("2 mint", coat.functions.balanceOf(A["bonus"]).call() - pool_before == price,
            f"{price // E18:,} COAT went to the bonus pool, none burned")
    r.check("2 mint", desks.functions.tokenURI(desk_id).call().startswith("data:application/json;base64,"),
            f"Desk #{desk_id} renders on chain")

    print("step 3: deposits and the $1,000 cap on money put in")
    send(alice, usdg.functions.approve(A["depositRouter"], 2_000 * E6), what="approve USDG")
    send(alice, router.functions.depositUsdg(desk_id, 600 * E6), what="alice deposits 600 USDG")
    r.check("3 cap", engine.functions.principalOf(desk_id).call() == 600 * E6
            and engine.functions.depositRoomOf(desk_id).call() == 400 * E6, "principal $600, room $400")
    r.check("3 cap", reverts(alice.address, router.functions.depositUsdg(desk_id, 500 * E6)),
            "a 500 USDG deposit is refused (only $400 of room)")
    before = engine.functions.principalOf(desk_id).call()
    send(alice, router.functions.depositEth(desk_id, 0), value=E18 // 100, what="alice deposits 0.01 ETH")
    eth_in = engine.functions.principalOf(desk_id).call() - before
    r.check("3 cap", eth_in > 0 and usdg.functions.balanceOf(acct).call() == 600 * E6 + eth_in,
            f"0.01 ETH arrived as {eth_in / E6:.2f} USDG and was booked")

    print("step 4: the keeper buys")
    k.tick()
    held = {t.address: engine.functions.heldQty(desk_id, t.address).call() for t in (taapl, tmsft, tnvda)}
    r.check("4 buy", all(held[t.address] == t.functions.balanceOf(acct).call() for t in (taapl, tmsft, tnvda))
            and sum(held.values()) > 0, "the keeper bought the basket into the Desk wallet")
    r.check("4 buy", engine.functions.investableOf(desk_id).call() < 5 * E6, "booked USDG is invested")
    r.check("4 buy", usdg.functions.balanceOf(A["engine"]).call() == engine.functions.feesAccrued().call(),
            "the engine holds only its fees")
    principal0 = engine.functions.principalOf(desk_id).call()

    print("step 5: shares the owner puts in themselves are never traded")
    send(deployer, taapl.functions.mint(alice.address, 5 * E18), what="alice gets 5 tAAPL of her own")
    send(alice, taapl.functions.transfer(acct, 5 * E18), what="alice sends them to her Desk wallet")
    wallet_aapl = taapl.functions.balanceOf(acct).call()
    r.check("5 own", reverts(deployer, engine.functions.sellStock(desk_id, A["taapl"], wallet_aapl)),
            "the engine refuses to sell more tAAPL than it bought")
    k.seen_epoch.clear()  # force the rebalance pass too
    k.tick()
    r.check("5 own", taapl.functions.balanceOf(acct).call() >= 5 * E18, "the keeper left alice's own tAAPL alone")
    r.check("5 own", engine.functions.principalOf(desk_id).call() == principal0, "principal unchanged")

    print("step 6: prices move, the room does not")
    v0 = managed(desk_id)
    for feed_key, mult in (("taaplFeed", 1.10), ("nvdaFeed", 0.92)):
        f = c(A[feed_key], FEED_W)
        send(f.functions.owner().call(), f.functions.setAnswer(int(f.functions.latestRoundData().call()[1] * mult)),
             what=f"{feed_key} {mult - 1:+.0%}")
    v1 = managed(desk_id)
    r.check("6 prices", engine.functions.principalOf(desk_id).call() == principal0 and v1 != v0,
            f"managed value ${v0:,.2f} -> ${v1:,.2f} ({(v1 / v0 - 1):+.2%}); principal ${principal0 / E6:,.2f} and room unchanged")

    print("step 7: a withdrawal frees room by what it is worth")
    q = tmsft.functions.balanceOf(acct).call() // 2
    msft_answer = c(A["msftFeed"], FEED_W).functions.latestRoundData().call()[1]
    worth = q * msft_answer * E6 // 10**26
    send(alice, wallet.functions.execute(A["tmsft"], 0, tmsft.functions.transfer(alice.address, q)._encode_transaction_data(), 0),
         what="alice takes half her tMSFT out")
    p2 = engine.functions.principalOf(desk_id).call()
    r.check("7 withdraw", abs((principal0 - p2) - worth) <= 1, f"room grew by ${worth / E6:,.2f}, the tMSFT's value")
    room = engine.functions.depositRoomOf(desk_id).call()
    send(alice, router.functions.depositUsdg(desk_id, room), what=f"alice fills the room ({room / E6:,.2f} USDG)")
    r.check("7 withdraw", engine.functions.principalOf(desk_id).call() == 1000 * E6
            and reverts(alice.address, router.functions.depositUsdg(desk_id, 1)), "principal at the cap; 1 more USDG is refused")

    print("step 8: fees to the Booster as ETH, Chainlink-floored")
    fees = engine.functions.feesAccrued().call()
    b0 = w3.eth.get_balance(A["booster"])
    send(deployer, engine.functions.flushFees(0), what=f"flush {fees / E6:.2f} USDG of fees (keeper floor 0)")
    got = w3.eth.get_balance(A["booster"]) - b0
    r.check("8 fees", engine.functions.feesAccrued().call() == 0 and got > 0,
            f"Booster received {got / E18:.6f} ETH (80%), floor {engine.functions.minEthForUsdg(fees).call() / E18:.6f} ETH for 100%")

    print("step 9: the Desk is sold whole")
    send(alice, desks.functions.transferFrom(alice.address, bob.address, desk_id), what="alice transfers the Desk to bob")
    r.check("9 sale", reverts(alice.address, wallet.functions.setEnginePaused(True)), "alice no longer controls the wallet")
    send(bob, wallet.functions.setEnginePaused(True), what="bob pauses the engine")
    r.check("9 sale", reverts(deployer, engine.functions.buyStock(desk_id, A["taapl"], 1)), "the engine cannot pull while paused")
    r.check("9 sale", value(acct) > 0 and usdg.functions.balanceOf(A["engine"]).call() == 0
            and all(t.functions.balanceOf(A["engine"]).call() == 0 for t in (taapl, tmsft, tnvda)),
            "the portfolio stayed in the Desk; the engine holds nothing")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [f"# Deployed check: {ADDRS.name}", "",
             f"Run {now} on an anvil fork of chain {w3.eth.chain_id} at block {fork_block:,}, against the contracts",
             "already deployed there (nothing redeployed, nothing sent to the real network). The keeper's own",
             "code made the buys; deployer and keeper transactions were impersonated on the fork.", "",
             "| step | check |", "|---|---|"] + [f"| {s} | {w} |" for s, w in r.checks]
    (DESK / "rehearsal" / "deployed-check.md").write_text("\n".join(lines) + "\n")
    print(f"\nALL {len(r.checks)} CHECKS PASSED against the deployed contracts -> rehearsal/deployed-check.md")
    return 0


if __name__ == "__main__":
    rehearse_local.rehearse = check  # reuse the anvil fork harness
    try:
        sys.exit(rehearse_local.main())
    except Fail as e:
        print(f"\nCHECK FAILED: {e}")
        sys.exit(1)
