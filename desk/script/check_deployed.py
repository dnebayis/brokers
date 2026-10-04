#!/usr/bin/env python3
"""Final check of a Desk deployment, on an anvil fork of its chain.

Testnet (default): forks Robinhood Chain testnet and drives the contracts ALREADY deployed there
(addresses from DESK_ADDRESSES), so what is tested is the bytecode users will call.

Mainnet (DESK_NETWORK=mainnet): forks Robinhood Chain mainnet, broadcasts
script/DeployDeskMainnet.s.sol onto the fork as the impersonated deployer (the real deploy,
rehearsed: same script, same live core, same 26 pools), then drives what it deployed. Mainnet
has no test tokens, so USDG comes from the WETH/USDG pool and the owner's "own" shares from the
stock's own pool, all on the fork; prices are the real Chainlink feeds, so they are not moved.

In both, the keeper's own code makes the buys:

    mint -> deposit (USDG, ETH) -> cap refusal -> keeper buys -> owner's own shares stay
    untouched -> [testnet: prices move, room unchanged] -> withdrawal frees room by its value
    -> fill to the cap -> fee flush (Chainlink floor) -> desk sale

Nothing reaches a real network. Output: rehearsal/deployed-check[-mainnet].md.

    cd desk && DESK_ADDRESSES=rehearsal/testnet-46630-v3.json python3 script/check_deployed.py
    cd desk && DESK_NETWORK=mainnet python3 script/check_deployed.py
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "keeper"))
from rehearse_local import DESK, E6, E18, ERC20, Fail, Run, _raw, abi  # noqa: E402
import desk_keeper  # noqa: E402
from eth_account import Account  # noqa: E402
from web3 import Web3  # noqa: E402

NETWORK = os.environ.get("DESK_NETWORK", "testnet")
MAINNET = NETWORK == "mainnet"
FORK_URL = os.environ.get(
    "FORK_RPC", "https://rpc.mainnet.chain.robinhood.com" if MAINNET else "https://rpc.testnet.chain.robinhood.com")
PORT = int(os.environ.get("ANVIL_PORT", "8548"))
RPC = f"http://127.0.0.1:{PORT}"
DEPLOYER = "0x9e643731dc9D8795573Aa34C410664407FfDC440"
FORK_ADDRS = DESK / "rehearsal" / "mainnet-fork-addresses.json"
# mainnet without DESK_ADDRESSES rehearses the deploy itself; with it, checks what is deployed
DEPLOY_ON_FORK = MAINNET and not os.environ.get("DESK_ADDRESSES")
ADDRS = FORK_ADDRS if DEPLOY_ON_FORK else DESK / os.environ.get(
    "DESK_ADDRESSES", "rehearsal/mainnet-4663.json" if MAINNET else "rehearsal/testnet-46630-v3.json")
FEED_W = desk_keeper.FEED  # latestRoundData, owner, setAnswer (test feeds)
POOL = [{"type": "function", "name": n, "stateMutability": "view", "inputs": [], "outputs": [{"type": "address"}]}
        for n in ("token0", "token1")]
ROUTES = [{"type": "function", "name": "routes", "stateMutability": "view",
           "inputs": [{"name": "s", "type": "address"}],
           "outputs": [{"name": "pool", "type": "address"}, {"name": "usdgIsToken0", "type": "bool"}]}]


def deploy_on_fork() -> None:
    """The mainnet deploy, broadcast onto the fork exactly as the deployer will run it."""
    env = dict(os.environ, DESK_OUT=str(FORK_ADDRS.relative_to(DESK)), DESK_OPEN_MINT="true")
    p = subprocess.run(["forge", "script", "script/DeployDeskMainnet.s.sol", "--rpc-url", RPC, "--broadcast",
                        "--unlocked", "--sender", DEPLOYER], cwd=DESK, env=env, capture_output=True, text=True)
    if p.returncode != 0:
        print(p.stdout[-3000:], p.stderr[-3000:])
        raise Fail("mainnet deploy script failed on the fork")
    wired = [line for line in p.stdout.splitlines() if "routes wired" in line or "skipped" in line]
    print("  " + "\n  ".join(wired))


def check(w3: Web3) -> int:
    r = Run()
    fork_block = w3.eth.block_number
    if DEPLOY_ON_FORK:
        print("step 0: the mainnet deploy script, broadcast on the fork")
        deploy_on_fork()
    A = {k: (Web3.to_checksum_address(v) if isinstance(v, str) and v.startswith("0x") else v)
         for k, v in json.loads(ADDRS.read_text()).items()}
    c = lambda a, x: w3.eth.contract(address=a, abi=x)  # noqa: E731
    usdg, coat = c(A["usdg"], ERC20), c(A["coat"], ERC20)
    desks, engine = c(A["desks"], abi("DeskNFT")), c(A["engine"], abi("DeskEngine"))
    router, renderer = c(A["depositRouter"], abi("DeskDepositRouter")), c(A["renderer"], abi("DeskRenderer"))
    keeper_addr = engine.functions.keeper().call()
    deployer = Web3.to_checksum_address(A["deployer"])
    alice, bob = Account.create(), Account.create()
    for who in (deployer, keeper_addr, alice.address, bob.address):
        w3.provider.make_request("anvil_setBalance", [who, hex(10 * E18)])
    if not desks.functions.mintOpen().call():  # deployed closed on purpose; opened on the fork only
        w3.provider.make_request("anvil_impersonateAccount", [deployer])
        w3.eth.wait_for_transaction_receipt(w3.eth.send_transaction(
            desks.functions.setMintOpen(True).build_transaction({"from": deployer})))
        print("  (mint was closed as deployed; opened on the fork for the check)")

    def send(sender, fn, value: int = 0, what: str = ""):
        if isinstance(sender, str):  # deployer, keeper or a pool, impersonated on the fork
            w3.provider.make_request("anvil_impersonateAccount", [sender])
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

    def give_usdg(to: str, amount: int, what: str) -> None:
        if MAINNET:  # the WETH/USDG pool holds millions; on the fork it can spare a few
            w3.provider.make_request("anvil_setBalance", [A["ethPool"], hex(E18)])
            send(A["ethPool"], usdg.functions.transfer(to, amount), what=what)
        else:
            send(deployer, usdg.functions.mint(to, amount), what=what)

    # the keeper's own code, impersonating the deployer (the engine owner may act as keeper)
    _, stocks, symbols = desk_keeper.load(ADDRS)
    k = desk_keeper.Keeper(w3, A, stocks, symbols)
    k.sync_stocks()
    names = [Web3.to_checksum_address(t) for t in k.stocks]
    tok = {t: c(t, ERC20) for t in names}

    def px(token: str) -> float:
        return k.price(token)

    def managed(desk: int) -> float:
        """What the engine runs for the Desk: its booked USDG plus the shares it bought."""
        v = engine.functions.investableOf(desk).call() / E6
        for t in names:
            q = engine.functions.heldQty(desk, t).call()
            v += q / E18 * px(t) if q else 0
        return v

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
    if MAINNET:
        basket, _, epoch = c(A["registry"], desk_keeper.REGISTRY).functions.getBasket(0).call()
        routed = [t for t in basket if c(A["engine"], ROUTES).functions.routes(t).call()[0] != desk_keeper.ZERO]
        r.check("1 config", len(names) == int(A["routes"]) and len(routed) == len(basket),
                f"{len(names)} names routed; the live basket (epoch {epoch}: "
                f"{', '.join(k.sym(t) for t in basket)}) is fully buyable")
        r.check("1 config", engine.functions.keeper().call() == A["keeper"] and c(A["bonus"], abi("CoatBonusPool"))
                .functions.poster().call() == A["poster"], "keeper and bonus poster as configured")

    print("step 2: alice mints a Desk")
    price = desks.functions.mintPrice().call()
    send(deployer, coat.functions.transfer(alice.address, price), what="alice gets the mint price in COAT")
    give_usdg(alice.address, 2_000 * E6, "alice gets 2,000 USDG")
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
    held = {t: engine.functions.heldQty(desk_id, t).call() for t in names}
    bought = {t: q for t, q in held.items() if q}
    r.check("4 buy", bought and all(q == tok[t].functions.balanceOf(acct).call() for t, q in bought.items()),
            "the keeper bought " + ", ".join(f"{q / E18:.4f} {k.sym(t)}" for t, q in bought.items())
            + " into the Desk wallet")
    r.check("4 buy", engine.functions.investableOf(desk_id).call() < 5 * E6, "booked USDG is invested")
    r.check("4 buy", usdg.functions.balanceOf(A["engine"]).call() == engine.functions.feesAccrued().call(),
            "the engine holds only its fees")
    principal0 = engine.functions.principalOf(desk_id).call()

    print("step 5: shares the owner puts in themselves are never traded")
    own_t = max(bought, key=lambda t: bought[t])
    own_q = bought[own_t] // 2
    if MAINNET:  # from the stock's own pool, on the fork
        pool = c(A["engine"], ROUTES).functions.routes(own_t).call()[0]
        w3.provider.make_request("anvil_setBalance", [pool, hex(E18)])
        send(pool, tok[own_t].functions.transfer(alice.address, own_q), what=f"alice gets {k.sym(own_t)} of her own")
    else:
        send(deployer, tok[own_t].functions.mint(alice.address, own_q), what=f"alice gets {k.sym(own_t)} of her own")
    send(alice, tok[own_t].functions.transfer(acct, own_q), what="alice sends them to her Desk wallet")
    in_wallet = tok[own_t].functions.balanceOf(acct).call()
    r.check("5 own", reverts(deployer, engine.functions.sellStock(desk_id, own_t, in_wallet)),
            f"the engine refuses to sell more {k.sym(own_t)} than it bought")
    k.seen_epoch.clear()  # force the rebalance pass too
    k.tick()
    r.check("5 own", tok[own_t].functions.balanceOf(acct).call() >= in_wallet,
            f"the keeper left alice's own {k.sym(own_t)} alone")
    r.check("5 own", engine.functions.principalOf(desk_id).call() == principal0, "principal unchanged")

    if not MAINNET:
        print("step 6: prices move, the room does not")
        v0 = managed(desk_id)
        for t, mult in zip(sorted(bought), (1.10, 0.92, 1.05)):
            f = c(c(A["booster"], desk_keeper.BOOSTER).functions.stockFeed(t).call(), FEED_W)
            send(f.functions.owner().call(), f.functions.setAnswer(int(f.functions.latestRoundData().call()[1] * mult)),
                 what=f"{k.sym(t)} feed {mult - 1:+.0%}")
        v1 = managed(desk_id)
        r.check("6 prices", engine.functions.principalOf(desk_id).call() == principal0 and v1 != v0,
                f"managed value ${v0:,.2f} -> ${v1:,.2f} ({(v1 / v0 - 1):+.2%}); principal ${principal0 / E6:,.2f} "
                "and room unchanged")
    else:
        print("step 6: (mainnet: prices are the real Chainlink feeds and are not moved)")
        r.check("6 prices", abs(managed(desk_id) - principal0 / E6) / (principal0 / E6) < 0.03,
                f"managed value ${managed(desk_id):,.2f} against ${principal0 / E6:,.2f} put in: fills within 3% of "
                "the feeds after the 0.5% fee")

    print("step 7: a withdrawal frees room by what it is worth")
    w_t = min(bought, key=lambda t: bought[t])
    q = engine.functions.heldQty(desk_id, w_t).call() // 2
    feed = c(c(A["booster"], desk_keeper.BOOSTER).functions.stockFeed(w_t).call(), FEED_W)
    worth = q * feed.functions.latestRoundData().call()[1] * E6 // 10**26
    p_before = engine.functions.principalOf(desk_id).call()
    send(alice, wallet.functions.execute(w_t, 0, tok[w_t].functions.transfer(alice.address, q)
                                         ._encode_transaction_data(), 0),
         what=f"alice takes half the engine's {k.sym(w_t)} out")
    p2 = engine.functions.principalOf(desk_id).call()
    r.check("7 withdraw", abs((p_before - p2) - worth) <= 1, f"room grew by ${worth / E6:,.2f}, the {k.sym(w_t)}'s value")
    room = engine.functions.depositRoomOf(desk_id).call()
    give_usdg(alice.address, room, f"alice gets {room / E6:,.2f} more USDG")
    send(alice, usdg.functions.approve(A["depositRouter"], room), what="approve USDG")
    send(alice, router.functions.depositUsdg(desk_id, room), what=f"alice fills the room ({room / E6:,.2f} USDG)")
    r.check("7 withdraw", engine.functions.principalOf(desk_id).call() == 1000 * E6
            and reverts(alice.address, router.functions.depositUsdg(desk_id, 1)), "principal at the cap; 1 more USDG is refused")
    print("step 8: the keeper invests the new USDG; fees reach the Booster as ETH, Chainlink-floored")
    b0 = w3.eth.get_balance(A["booster"])
    k.tick()  # buys with the new USDG, and flushes once fees pass $5
    left = engine.functions.feesAccrued().call()
    if left:  # under the keeper's $5 floor: flush by hand, with no keeper floor at all
        send(deployer, engine.functions.flushFees(0), what=f"flush {left / E6:.2f} USDG of fees (keeper floor 0)")
    got = w3.eth.get_balance(A["booster"]) - b0
    r.check("8 fees", engine.functions.feesAccrued().call() == 0 and got > 0,
            f"the Booster received {got / E18:.6f} ETH (its 80%), every fill above the Chainlink ETH/USD floor")
    r.check("8 fees", engine.functions.investableOf(desk_id).call() < 5 * E6, "the room filled after the withdrawal is invested")

    print("step 9: the Desk is sold whole")
    send(alice, desks.functions.transferFrom(alice.address, bob.address, desk_id), what="alice transfers the Desk to bob")
    r.check("9 sale", reverts(alice.address, wallet.functions.setEnginePaused(True)), "alice no longer controls the wallet")
    send(bob, wallet.functions.setEnginePaused(True), what="bob pauses the engine")
    r.check("9 sale", reverts(deployer, engine.functions.buyStock(desk_id, own_t, 1)), "the engine cannot pull while paused")
    r.check("9 sale", sum(tok[t].functions.balanceOf(acct).call() for t in names) > 0
            and usdg.functions.balanceOf(A["engine"]).call() == 0
            and all(tok[t].functions.balanceOf(A["engine"]).call() == 0 for t in names),
            "the portfolio stayed in the Desk; the engine holds nothing")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    what = ("the mainnet deploy script broadcast onto the fork (the real deploy, rehearsed), then its contracts"
            if DEPLOY_ON_FORK else f"the contracts already deployed there ({ADDRS.name}; nothing redeployed)")
    lines = [f"# Deployed check: {NETWORK}", "",
             f"Run {now} on an anvil fork of chain {w3.eth.chain_id} at block {fork_block:,}, against {what}.",
             "Nothing was sent to a real network. The keeper's own code made the buys; deployer, keeper and pool",
             "transactions were impersonated on the fork.", "",
             "| step | check |", "|---|---|"] + [f"| {s} | {w} |" for s, w in r.checks]
    out = DESK / "rehearsal" / ("deployed-check-mainnet.md" if MAINNET else "deployed-check.md")
    out.write_text("\n".join(lines) + "\n")
    print(f"\nALL {len(r.checks)} CHECKS PASSED -> {out.relative_to(DESK)}")
    return 0


def main() -> int:
    # a metered archive endpoint keeps the fork's pinned block readable for the whole run (the
    # public mainnet node drops old state within minutes); it only answers the site's origin
    origin = os.environ.get("FORK_ORIGIN", "https://coattail.cash" if "alchemy" in FORK_URL else "")
    anvil = subprocess.Popen(
        ["anvil", "--fork-url", FORK_URL, "--port", str(PORT), "--auto-impersonate", "--silent"]
        + (["--fork-header", f"Origin: {origin}"] if origin else []),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid,
    )
    try:
        w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 120}))
        for _ in range(120):
            try:
                if w3.is_connected() and w3.eth.chain_id in (4663, 46630):
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


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fail as e:
        print(f"\nCHECK FAILED: {e}")
        sys.exit(1)
