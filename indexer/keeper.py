#!/usr/bin/env python3
"""Threshold-aware permissionless Booster keeper.

Reads are always safe. A transaction is sent only with --execute, active shares
are non-zero, and the buffered ETH meets pokeThreshold. This process is entirely
independent of the Congress data source and always uses the last valid on-chain
basket.
"""

import argparse
import json
import os
import time
from datetime import datetime, timezone
from typing import Callable, Dict, List

from config import (
    BUYBACK_BURNER_ADDRESS,
    BUYBACK_THRESHOLD_WEI,
    CHAIN_ID,
    FEE_SPLITTER_ADDRESS,
    HOOK_ADDRESS,
    KEEPER_PRIVATE_KEY,
    make_web3,
    wei_env,
)


def is_poke_eligible(balance: int, threshold: int, active_shares: int) -> bool:
    """Return whether a useful poke can be submitted."""
    return active_shares > 0 and balance >= threshold


def planned_actions(
    hook_eth: int,
    hook_coat: int,
    splitter_eth: int,
    booster_eth: int,
    poke_threshold: int,
    active_shares: int,
    buyback_eth: int,
    buyback_threshold: int,
) -> List[str]:
    """Pure action plan used by the runner and unit tests."""
    actions = []
    if hook_eth > 0 or hook_coat > 0:
        actions.append("hook.flush")
    if splitter_eth > 0 or hook_eth > 0:
        actions.append("splitter.flush")
    projected_booster = booster_eth + (splitter_eth + hook_eth) * 8_000 // 10_000
    if is_poke_eligible(projected_booster, poke_threshold, active_shares):
        actions.append("booster.poke")
    projected_buyback = buyback_eth + (splitter_eth + hook_eth) * 1_000 // 10_000
    if projected_buyback >= buyback_threshold:
        actions.append("buyback.execute")
    return actions


def _address(value: str, name: str, Web3):
    if not value:
        return None
    if not Web3.is_address(value):
        raise RuntimeError(f"{name} is not a valid address")
    return Web3.to_checksum_address(value)


def _diagnose_poke(w3, booster, registry_abi, booster_address, buffer_wei) -> None:
    """Simulate the on-chain basket leg by leg and report which routes cannot fill.

    Read-only and best-effort: this runs only after a poke has already failed, so it must
    never raise and turn a diagnosis into a second outage.
    """
    try:
        from route_preflight import simulate_leg

        registry = w3.eth.contract(address=booster.functions.registry().call(), abi=registry_abi)
        tokens, weights, epoch = registry.functions.getBasket(
            int(booster.functions.strategyId().call())
        ).call()
        router_address = booster.functions.router().call()
        dead = []
        for token, bps in zip(tokens, weights):
            slice_wei = (buffer_wei * int(bps)) // 10_000
            if slice_wei == 0:
                continue  # _poke skips a zero slice; it cannot be the cause
            ok, _out, reason = simulate_leg(w3, router_address, booster_address, token, slice_wei)
            if not ok:
                dead.append({"token": token, "bps": int(bps), "reason": reason})
        print(json.dumps({"action": "poke.diagnosis", "epoch": int(epoch),
                          "bufferWei": buffer_wei, "deadRoutes": dead}, sort_keys=True))
        if dead:
            print("::warning::poke blocked by illiquid route(s): " +
                  ", ".join(d["token"] for d in dead) +
                  " — rerun the indexer to repost the basket without them")
    except Exception as exc:
        print(json.dumps({"action": "poke.diagnosis", "status": "unavailable", "error": str(exc)[:200]}))



def _holdings_floor_usdg(w3, engine, floor_addr, token_id):
    """Chainlink-floored USDG value of what a Broker's wallet holds, or None if unreadable.

    Both the run-worth-it check and the $COAT guard build on this: the protocol's own
    conservative valuation of the stock sitting in that Broker's wallet.
    """
    from web3 import Web3

    if not floor_addr:
        return None
    try:
        brokers_addr = engine.functions.brokers().call()
        booster_addr = engine.functions.booster().call()
        tba = w3.eth.contract(address=Web3.to_checksum_address(brokers_addr), abi=[
            {"type": "function", "name": "accountOf", "stateMutability": "view",
             "inputs": [{"name": "tokenId", "type": "uint256"}],
             "outputs": [{"name": "", "type": "address"}]},
        ]).functions.accountOf(token_id).call()
        booster = w3.eth.contract(address=Web3.to_checksum_address(booster_addr), abi=[
            {"type": "function", "name": "knownTokenCount", "stateMutability": "view",
             "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
            {"type": "function", "name": "knownTokens", "stateMutability": "view",
             "inputs": [{"name": "i", "type": "uint256"}],
             "outputs": [{"name": "", "type": "address"}]},
        ])
        floor = w3.eth.contract(address=Web3.to_checksum_address(floor_addr), abi=[
            {"type": "function", "name": "minUsdgOut", "stateMutability": "view",
             "inputs": [{"name": "stock", "type": "address"}, {"name": "amount", "type": "uint256"}],
             "outputs": [{"name": "", "type": "uint256"}]},
        ])
        erc20 = [{"type": "function", "name": "balanceOf", "stateMutability": "view",
                  "inputs": [{"name": "a", "type": "address"}],
                  "outputs": [{"name": "", "type": "uint256"}]}]
        total = 0
        for i in range(int(booster.functions.knownTokenCount().call())):
            stock = booster.functions.knownTokens(i).call()
            bal = int(w3.eth.contract(address=stock, abi=erc20).functions.balanceOf(tba).call())
            if bal:
                total += int(floor.functions.minUsdgOut(stock, bal).call())
        return total
    except Exception:
        return None


def _coat_min_out(w3, engine, floor_addr, booster_address, token_id):
    """Minimum $COAT a TO_COAT playbook must deliver, or None if it cannot be priced.

    Mirrors what the venue will actually do: every stock the Broker holds is floored by the
    Floor's Chainlink guard (`minUsdgOut`), the fee comes off, the total is converted to ETH
    at the Booster's own ETH/USD source, and CoatRouter's spot `quoteBuy` turns that into
    COAT. The spot views exclude the hooked pool's ~1% fee, so 2% comes off for the pool and
    1% more for ordinary drift between this call and the mined transaction.
    """
    from web3 import Web3

    if not floor_addr:
        return None
    try:
        brokers_addr = engine.functions.brokers().call()
        booster_addr = engine.functions.booster().call()
        tba = w3.eth.contract(address=Web3.to_checksum_address(brokers_addr), abi=[
            {"type": "function", "name": "accountOf", "stateMutability": "view",
             "inputs": [{"name": "tokenId", "type": "uint256"}],
             "outputs": [{"name": "", "type": "address"}]},
        ]).functions.accountOf(token_id).call()
        booster = w3.eth.contract(address=Web3.to_checksum_address(booster_addr), abi=[
            {"type": "function", "name": "knownTokenCount", "stateMutability": "view",
             "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
            {"type": "function", "name": "knownTokens", "stateMutability": "view",
             "inputs": [{"name": "i", "type": "uint256"}],
             "outputs": [{"name": "", "type": "address"}]},
            {"type": "function", "name": "ethUsdFeed", "stateMutability": "view",
             "inputs": [], "outputs": [{"name": "", "type": "address"}]},
            {"type": "function", "name": "ethUsdManualE8", "stateMutability": "view",
             "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
        ])
        floor = w3.eth.contract(address=Web3.to_checksum_address(floor_addr), abi=[
            {"type": "function", "name": "minUsdgOut", "stateMutability": "view",
             "inputs": [{"name": "stock", "type": "address"}, {"name": "amount", "type": "uint256"}],
             "outputs": [{"name": "", "type": "uint256"}]},
            {"type": "function", "name": "feeBps", "stateMutability": "view",
             "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
            {"type": "function", "name": "usdg", "stateMutability": "view",
             "inputs": [], "outputs": [{"name": "", "type": "address"}]},
            {"type": "function", "name": "coatRouter", "stateMutability": "view",
             "inputs": [], "outputs": [{"name": "", "type": "address"}]},
        ])
        erc20 = [{"type": "function", "name": "balanceOf", "stateMutability": "view",
                  "inputs": [{"name": "a", "type": "address"}],
                  "outputs": [{"name": "", "type": "uint256"}]},
                 {"type": "function", "name": "decimals", "stateMutability": "view",
                  "inputs": [], "outputs": [{"name": "", "type": "uint8"}]}]

        floor_usdg = 0
        for i in range(int(booster.functions.knownTokenCount().call())):
            stock = booster.functions.knownTokens(i).call()
            bal = int(w3.eth.contract(address=stock, abi=erc20).functions.balanceOf(tba).call())
            if bal:
                floor_usdg += int(floor.functions.minUsdgOut(stock, bal).call())
        if floor_usdg == 0:
            return None

        net_usdg = floor_usdg * (10_000 - int(floor.functions.feeBps().call())) // 10_000
        usdg_dec = int(w3.eth.contract(address=floor.functions.usdg().call(),
                                       abi=erc20).functions.decimals().call())
        feed_addr = booster.functions.ethUsdFeed().call()
        if int(feed_addr, 16) != 0:
            eth_usd8 = int(w3.eth.contract(address=feed_addr, abi=[
                {"type": "function", "name": "latestRoundData", "stateMutability": "view",
                 "inputs": [], "outputs": [
                     {"name": "a", "type": "uint80"}, {"name": "answer", "type": "int256"},
                     {"name": "c", "type": "uint256"}, {"name": "d", "type": "uint256"},
                     {"name": "e", "type": "uint80"}]},
            ]).functions.latestRoundData().call()[1])
        else:
            eth_usd8 = int(booster.functions.ethUsdManualE8().call())
        if eth_usd8 <= 0:
            return None

        eth_wei = net_usdg * 10 ** 8 * 10 ** 18 // (10 ** usdg_dec * eth_usd8)
        eth_wei = eth_wei * 99 // 100  # the USDG->WETH leg's own spread
        coat_spot = int(w3.eth.contract(
            address=Web3.to_checksum_address(floor.functions.coatRouter().call()), abi=[
                {"type": "function", "name": "quoteBuy", "stateMutability": "view",
                 "inputs": [{"name": "ethIn", "type": "uint256"}],
                 "outputs": [{"name": "", "type": "uint256"}]},
            ]).functions.quoteBuy(eth_wei).call())
        guard = coat_spot * 98 // 100 * 99 // 100
        return guard if guard > 0 else None
    except Exception:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Coattail Booster keeper")
    parser.add_argument("--execute", action="store_true", help="send poke when eligible")
    args = parser.parse_args()

    from web3 import Web3

    import os
    address = os.environ.get("BOOSTER_ADDRESS", "")
    if not address:
        raise RuntimeError("BOOSTER_ADDRESS not set")
    w3 = make_web3()
    booster_address = Web3.to_checksum_address(address)
    booster_abi = [
        {"type": "function", "name": "pokeThreshold", "stateMutability": "view", "inputs": [],
         "outputs": [{"name": "", "type": "uint256"}]},
        {"type": "function", "name": "activeShares", "stateMutability": "view", "inputs": [],
         "outputs": [{"name": "", "type": "uint256"}]},
        {"type": "function", "name": "poke", "stateMutability": "nonpayable", "inputs": [], "outputs": []},
        {"type": "function", "name": "poke", "stateMutability": "nonpayable",
         "inputs": [{"name": "maxSpend", "type": "uint256"}], "outputs": []},
        {"type": "function", "name": "registry", "stateMutability": "view", "inputs": [],
         "outputs": [{"name": "", "type": "address"}]},
        {"type": "function", "name": "strategyId", "stateMutability": "view", "inputs": [],
         "outputs": [{"name": "", "type": "uint256"}]},
        {"type": "function", "name": "router", "stateMutability": "view", "inputs": [],
         "outputs": [{"name": "", "type": "address"}]},
    ]
    registry_abi = [
        {"type": "function", "name": "getBasket", "stateMutability": "view",
         "inputs": [{"name": "strategyId", "type": "uint256"}],
         "outputs": [{"name": "tokens", "type": "address[]"},
                     {"name": "weightsBps", "type": "uint16[]"},
                     {"name": "epoch", "type": "uint64"}]},
    ]
    flush_abi = [{"type": "function", "name": "flush", "stateMutability": "nonpayable", "inputs": [], "outputs": []}]
    hook_abi = flush_abi + [
        {"type": "function", "name": "coat", "stateMutability": "view", "inputs": [],
         "outputs": [{"name": "", "type": "address"}]},
    ]
    erc20_abi = [{"type": "function", "name": "balanceOf", "stateMutability": "view",
                  "inputs": [{"name": "", "type": "address"}],
                  "outputs": [{"name": "", "type": "uint256"}]}]
    buyback_abi = [{"type": "function", "name": "executeBuyback", "stateMutability": "nonpayable",
                    "inputs": [], "outputs": [{"name": "burned", "type": "uint256"}]}]

    booster = w3.eth.contract(address=booster_address, abi=booster_abi)
    hook_address = _address(HOOK_ADDRESS, "HOOK_ADDRESS", Web3)
    splitter_address = _address(FEE_SPLITTER_ADDRESS, "FEE_SPLITTER_ADDRESS", Web3)
    buyback_address = _address(BUYBACK_BURNER_ADDRESS, "BUYBACK_BURNER_ADDRESS", Web3)
    hook = w3.eth.contract(address=hook_address, abi=hook_abi) if hook_address else None
    splitter = w3.eth.contract(address=splitter_address, abi=flush_abi) if splitter_address else None
    buyback = w3.eth.contract(address=buyback_address, abi=buyback_abi) if buyback_address else None

    threshold = int(booster.functions.pokeThreshold().call())
    shares = int(booster.functions.activeShares().call())
    booster_balance = int(w3.eth.get_balance(booster_address))
    hook_eth = int(w3.eth.get_balance(hook_address)) if hook_address else 0
    hook_coat = 0
    if hook:
        coat_address = Web3.to_checksum_address(hook.functions.coat().call())
        coat = w3.eth.contract(address=coat_address, abi=erc20_abi)
        hook_coat = int(coat.functions.balanceOf(hook_address).call())
    splitter_eth = int(w3.eth.get_balance(splitter_address)) if splitter_address else 0
    buyback_eth = int(w3.eth.get_balance(buyback_address)) if buyback_address else 0
    plan = planned_actions(
        hook_eth, hook_coat, splitter_eth, booster_balance, threshold, shares,
        buyback_eth, BUYBACK_THRESHOLD_WEI,
    )
    # Report the relay wallet's own gas here so an external watchdog can read the balance
    # straight out of this run's log. Running dry is the keeper's most common real outage and
    # it is otherwise invisible until a stage fails mid-run.
    keeper_gas_wei = 0
    if KEEPER_PRIVATE_KEY:
        try:
            keeper_gas_wei = int(
                w3.eth.get_balance(w3.eth.account.from_key(KEEPER_PRIVATE_KEY).address)
            )
        except Exception:  # never let a reporting read break the keeper
            keeper_gas_wei = 0
    status: Dict = {
        "activeShares": shares,
        "boosterBalanceWei": booster_balance,
        "pokeThresholdWei": threshold,
        "hookEthWei": hook_eth,
        "hookCoatRaw": hook_coat,
        "splitterBalanceWei": splitter_eth,
        "buybackBalanceWei": buyback_eth,
        "buybackThresholdWei": BUYBACK_THRESHOLD_WEI,
        "keeperGasWei": keeper_gas_wei,
        "planned": plan,
    }
    print(json.dumps(status, sort_keys=True))
    # Running dry is the keeper's most common real outage. Emit a workflow warning while
    # there is still gas for several runs, so the watchdog can page before a stage fails
    # mid-run and strands the buffered fees for an hour.
    gas_floor = wei_env("KEEPER_GAS_FLOOR_WEI", "10000000000000000")  # 0.01 ETH
    if KEEPER_PRIVATE_KEY and 0 < keeper_gas_wei < gas_floor:
        from ops_alerts import alert
        gas_message = (f"keeper relay low on gas: {keeper_gas_wei / 1e18:.5f} ETH "
                       f"(floor {gas_floor / 1e18:.5f} ETH) — top up the relay wallet")
        print(f"::warning::{gas_message}")
        alert(f"⛽ {gas_message}")
    if not args.execute or not plan:
        return
    if not KEEPER_PRIVATE_KEY:
        raise RuntimeError("KEEPER_PRIVATE_KEY not set for keeper relay")

    account = w3.eth.account.from_key(KEEPER_PRIVATE_KEY)
    poke_max_wei = wei_env("KEEPER_POKE_MAX_WEI", "1000000000000000000")
    failed_actions = []
    failed_errors: Dict[str, str] = {}

    # RH Chain's proxied RPC can briefly serve a stale balance right after a dependent tx is
    # mined — e.g. splitter.flush's gas estimate landing before hook.flush's ETH is visible —
    # so eth_estimateGas returns the cheap `if (bal == 0) return` path (~24k) and the tx is sent
    # under-gassed, reverting out-of-gas (receipt status 0). Guard every stage with an explicit
    # floor plus a 2x buffer over the estimate. RH gas is ~0.02 gwei, so an oversized limit costs
    # nothing (only gas actually used is billed); this only removes the OOG failure mode.
    def submit(label: str, fn: Callable, min_gas: int = 300_000) -> bool:
        try:
            call = fn()
            estimate = call.estimate_gas({"from": account.address})
            gas_limit = max(int(estimate * 2), min_gas)
            # The same proxied-RPC lag can serve a stale get_transaction_count right after a preceding
            # stage's tx is mined — "pending" can even trail the confirmed "latest" count — so a naive
            # read collides ("nonce too low"). Seed from max(pending, latest) and, on a nonce error,
            # advance to max(nonce+1, latest) so a lagging read can never pin the send too low.
            nonce = max(
                w3.eth.get_transaction_count(account.address, "pending"),
                w3.eth.get_transaction_count(account.address, "latest"),
            )
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
                        nonce = max(nonce + 1, w3.eth.get_transaction_count(account.address, "latest"))
                        continue
                    raise
            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
            if receipt.status != 1:
                raise RuntimeError(f"receipt status {receipt.status}")
            print(json.dumps({"action": label, "status": "success", "tx": tx_hash.hex()}))
            return True
        except Exception as exc:
            # Stages are intentionally isolated: a temporarily unavailable buyback
            # TWAP must not prevent fee flushing or stock purchases, and vice versa.
            print(json.dumps({"action": label, "status": "deferred", "error": str(exc)}))
            failed_actions.append(label)
            failed_errors[label] = str(exc)
            return False

    if "hook.flush" in plan and hook:
        submit("hook.flush", lambda: hook.functions.flush())
    flushed = False
    if "splitter.flush" in plan and splitter:
        flushed = submit("splitter.flush", lambda: splitter.functions.flush())

    # Re-read balances after upstream flushes instead of trusting projections. RH's proxied RPC can
    # serve a stale (pre-flush) Booster balance right after splitter.flush moves ETH in, which would
    # wrongly skip an eligible poke and strand the buffer. When a flush just landed, poll a few times
    # and keep the max so the lagging read can't hide the freshly-flushed balance.
    booster_balance = int(w3.eth.get_balance(booster_address))
    if flushed:
        for _ in range(4):
            if booster_balance >= threshold:
                break
            time.sleep(2)
            booster_balance = max(booster_balance, int(w3.eth.get_balance(booster_address)))
    if is_poke_eligible(booster_balance, threshold, shares):
        # Pre-flight the poke as a free eth_call before spending relay gas. During a venue-wide
        # halt (all Rialto pools reverting "ACF" for 13+ hours on 2026-08-25/26) every on-chain
        # attempt burns real relay gas and changes nothing; hourly retries drained the relay
        # below its floor. A revert here defers the stage with zero cost; the first run after
        # the venue recovers passes the call and the poke goes on-chain as before.
        try:
            booster.functions.poke(poke_max_wei).call({"from": account.address})
            poke_sendable = True
        except Exception as exc:
            print(json.dumps({"action": "booster.poke", "status": "deferred",
                              "error": f"pre-flight revert: {str(exc)[:200]}"}))
            failed_actions.append("booster.poke")
            failed_errors["booster.poke"] = f"pre-flight revert: {str(exc)[:300]}"
            _diagnose_poke(w3, booster, registry_abi, booster_address,
                           min(booster_balance, poke_max_wei))
            poke_sendable = False
        # poke buys the whole basket in one tx; real usage scales with the number of routes
        # (observed 0.24M–1.0M). Floor high so a stale-low estimate can never under-gas it.
        poked = poke_sendable and submit(
            "booster.poke", lambda: booster.functions.poke(poke_max_wei), min_gas=2_000_000)
        if poke_sendable and not poked:
            # The basket is bought atomically, so one illiquid route reverts every leg and the
            # buffer sits until the next indexer epoch replaces the basket — up to six hours of
            # silent stalling. The indexer pre-flights routes before posting, but liquidity can
            # die between epochs, so name the culprit here instead of leaving a bare revert.
            _diagnose_poke(w3, booster, registry_abi, booster_address,
                           min(booster_balance, poke_max_wei))
    buyback_eth = int(w3.eth.get_balance(buyback_address)) if buyback_address else 0
    if buyback and buyback_eth >= BUYBACK_THRESHOLD_WEI:
        # buyback is a single v4 swap + burn.
        submit("buyback.execute", lambda: buyback.functions.executeBuyback(), min_gas=800_000)
    # The Floor: flush accrued terminal fees to the Booster as native ETH. Entirely
    # env-gated — without FLOOR_ROUTER set this block is inert, so shipping it ahead of the
    # venue's mainnet launch changes nothing in production.
    floor_addr = os.environ.get("FLOOR_ROUTER", "").strip()
    if floor_addr:
        try:
            floor = w3.eth.contract(address=Web3.to_checksum_address(floor_addr), abi=[
                {"type": "function", "name": "feesAccrued", "stateMutability": "view",
                 "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
                {"type": "function", "name": "usdg", "stateMutability": "view",
                 "inputs": [], "outputs": [{"name": "", "type": "address"}]},
                {"type": "function", "name": "flushFees", "stateMutability": "nonpayable",
                 "inputs": [{"name": "minEthOut", "type": "uint256"}], "outputs": []},
            ])
            fees_raw = int(floor.functions.feesAccrued().call())
            usdg_addr = floor.functions.usdg().call()
            usdg_dec = int(w3.eth.contract(address=usdg_addr, abi=[
                {"type": "function", "name": "decimals", "stateMutability": "view",
                 "inputs": [], "outputs": [{"name": "", "type": "uint8"}]},
            ]).functions.decimals().call())
            flush_min = int(os.environ.get("FLOOR_FLUSH_MIN_USDG", "20")) * 10 ** usdg_dec
            if fees_raw >= flush_min:
                # sandwich floor from the Booster's own ETH/USD source (feed, else fresh manual)
                bfeed = w3.eth.contract(address=booster_address, abi=[
                    {"type": "function", "name": "ethUsdFeed", "stateMutability": "view",
                     "inputs": [], "outputs": [{"name": "", "type": "address"}]},
                    {"type": "function", "name": "ethUsdManualE8", "stateMutability": "view",
                     "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
                ])
                feed_addr = bfeed.functions.ethUsdFeed().call()
                if int(feed_addr, 16) != 0:
                    eth_usd8 = int(w3.eth.contract(address=feed_addr, abi=[
                        {"type": "function", "name": "latestRoundData", "stateMutability": "view",
                         "inputs": [], "outputs": [
                             {"name": "a", "type": "uint80"}, {"name": "answer", "type": "int256"},
                             {"name": "c", "type": "uint256"}, {"name": "d", "type": "uint256"},
                             {"name": "e", "type": "uint80"}]},
                    ]).functions.latestRoundData().call()[1])
                else:
                    eth_usd8 = int(bfeed.functions.ethUsdManualE8().call())
                # expected ETH = fees_usd / ethUsd, floored at 97% against sandwiches
                min_eth = fees_raw * 10 ** 8 * 10 ** 18 * 97 // (10 ** usdg_dec * eth_usd8 * 100)
                submit("floor.flush", lambda: floor.functions.flushFees(min_eth), min_gas=700_000)
            else:
                print(json.dumps({"action": "floor.flush", "status": "skipped",
                                  "feesRaw": fees_raw, "minRaw": flush_min}))
        except Exception as exc:  # never let the venue stage break payroll stages
            print(json.dumps({"action": "floor.flush", "status": "deferred", "error": str(exc)[:200]}))

    # Playbooks: execute holders' standing orders (auto-claim / sweep / convert). Same
    # env-gating contract as the Floor stage — without PLAYBOOKS_ENGINE set this is inert.
    pb_addr = os.environ.get("PLAYBOOKS_ENGINE", "").strip()
    if pb_addr:
        try:
            engine = w3.eth.contract(address=Web3.to_checksum_address(pb_addr), abi=[
                {"type": "function", "name": "enrolledCount", "stateMutability": "view",
                 "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
                {"type": "function", "name": "enrolledAt", "stateMutability": "view",
                 "inputs": [{"name": "i", "type": "uint256"}],
                 "outputs": [{"name": "", "type": "uint256"}]},
                {"type": "function", "name": "playbookOf", "stateMutability": "view",
                 "inputs": [{"name": "tokenId", "type": "uint256"}], "outputs": [
                     {"name": "autoClaim", "type": "bool"}, {"name": "mode", "type": "uint8"},
                     {"name": "dest", "type": "address"}, {"name": "paused", "type": "bool"}]},
                {"type": "function", "name": "run", "stateMutability": "nonpayable",
                 "inputs": [{"name": "ids", "type": "uint256[]"},
                            {"name": "minOuts", "type": "uint256[]"}], "outputs": []},
            ])
            pb_batch = int(os.environ.get("PLAYBOOKS_MAX_BATCH", "25"))
            total = int(engine.functions.enrolledCount().call())
            ids, min_outs = [], []
            # Running a playbook costs ~1M gas; a Broker earns cents an hour. Converting
            # every hour would burn far more gas than the salary is worth, so an order only
            # runs once the Broker's wallet is worth moving. Claiming stays hourly and free
            # for everyone — this gate only delays the sweep/convert step, never the earning.
            min_usdg_env = float(os.environ.get("PLAYBOOKS_MIN_USDG", "5"))
            usdg_dec_pb = None
            for i in range(min(total, pb_batch)):
                token_id = int(engine.functions.enrolledAt(i).call())
                mode = int(engine.functions.playbookOf(token_id).call()[1])
                if mode != 0:
                    if usdg_dec_pb is None:
                        usdg_dec_pb = int(w3.eth.contract(
                            address=floor.functions.usdg().call(), abi=[
                                {"type": "function", "name": "decimals", "stateMutability": "view",
                                 "inputs": [], "outputs": [{"name": "", "type": "uint8"}]},
                            ]).functions.decimals().call())
                    worth = _holdings_floor_usdg(w3, engine, floor_addr, token_id)
                    threshold = int(min_usdg_env * 10 ** usdg_dec_pb)
                    if worth is None or worth < threshold:
                        print(json.dumps({"action": "playbooks.run", "tokenId": token_id,
                                          "status": "waiting", "worthRaw": worth,
                                          "minRaw": threshold}))
                        continue
                if mode == 3:
                    # TO_COAT crosses the hooked pool, which has no Chainlink floor of its
                    # own, so the guard has to be computed here: Chainlink floors of the
                    # Broker's holdings -> ETH at the Booster's own price -> COAT at spot,
                    # then haircut for the pool's fee and normal drift. A quote we cannot
                    # compute means we skip that order rather than send an unguarded zero.
                    guard = _coat_min_out(w3, engine, floor_addr, booster_address, token_id)
                    if guard is None:
                        print(json.dumps({"action": "playbooks.run", "tokenId": token_id,
                                          "status": "skipped", "reason": "no COAT quote"}))
                        continue
                    ids.append(token_id)
                    min_outs.append(guard)
                    continue
                ids.append(token_id)
                min_outs.append(0)
            if ids:
                submit("playbooks.run", lambda: engine.functions.run(ids, min_outs),
                       min_gas=500_000 + 700_000 * len(ids))
            else:
                print(json.dumps({"action": "playbooks.run", "status": "skipped",
                                  "enrolled": total}))
        except Exception as exc:  # standing orders defer to the next hour, never break payroll
            print(json.dumps({"action": "playbooks.run", "status": "deferred", "error": str(exc)[:200]}))

    if failed_actions:
        # Stages are isolated by design: a deferred stage retries next run and never
        # strands funds. `buyback.execute` legitimately defers early (SpotTooFarFromTwap
        # while the fresh pool's spot and TWAP converge) — that must NOT hard-fail the run,
        # because a non-zero exit skips the downstream claim-distribution step and the
        # stock the poke just bought would never reach the broker TBAs. Only flush/poke
        # deferrals (which do strand value / block distribution) are fatal under strict.
        message = "keeper stages deferred: " + ", ".join(failed_actions)
        fatal = [a for a in failed_actions if a not in ("buyback.execute", "floor.flush", "playbooks.run")]
        # Weekend BadFeed (0xb0171a5d) is the market being closed, not a fault: stock
        # feeds stop updating after Friday's close, the staleness guard trips, and the
        # poke rightly refuses to buy on stale prices. Funds simply accrue until Monday.
        # Only on weekdays does a BadFeed deferral signal a real feed problem.
        # Judge only the actions still considered fatal: buyback.execute is already
        # non-fatal above (its TWAP guard, e.g. SpotTooFarFromTwap 0x81e45c32, defers
        # by design and must not veto the weekend exemption for the poke).
        weekend = datetime.now(timezone.utc).weekday() >= 5
        if weekend and set(fatal) <= {"booster.poke"} \
                and all("0xb0171a5d" in str(failed_errors.get(a, "")) for a in fatal):
            print(f"::warning::{message} — weekend feed staleness (market closed); "
                  "funds accrue until Monday's first fresh feed")
            fatal = []
        if fatal and os.environ.get("KEEPER_STRICT") == "1":
            from ops_alerts import alert
            alert("🔴 keeper FAILED — " + message + " | " +
                  "; ".join(f"{a}: {str(failed_errors.get(a, ''))[:120]}" for a in fatal))
            raise RuntimeError(message)
        print(f"::warning::{message}")


if __name__ == "__main__":
    main()
