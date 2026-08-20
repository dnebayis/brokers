#!/usr/bin/env python3
"""Threshold-aware permissionless Booster keeper.

Reads are always safe. A transaction is sent only with --execute, active shares
are non-zero, and the buffered ETH meets pokeThreshold. This process is entirely
independent of the Congress data source and always uses the last valid on-chain
basket.
"""

import argparse
import json
import time
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
        print(f"::warning::keeper relay low on gas: {keeper_gas_wei / 1e18:.5f} ETH "
              f"(floor {gas_floor / 1e18:.5f} ETH) — top up the relay wallet")
    if not args.execute or not plan:
        return
    if not KEEPER_PRIVATE_KEY:
        raise RuntimeError("KEEPER_PRIVATE_KEY not set for keeper relay")

    account = w3.eth.account.from_key(KEEPER_PRIVATE_KEY)
    poke_max_wei = wei_env("KEEPER_POKE_MAX_WEI", "1000000000000000000")
    failed_actions = []

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
        # poke buys the whole basket in one tx; real usage scales with the number of routes
        # (observed 0.24M–1.0M). Floor high so a stale-low estimate can never under-gas it.
        poked = submit("booster.poke", lambda: booster.functions.poke(poke_max_wei), min_gas=2_000_000)
        if not poked:
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
    if failed_actions:
        # Stages are isolated by design: a deferred stage retries next run and never
        # strands funds. `buyback.execute` legitimately defers early (SpotTooFarFromTwap
        # while the fresh pool's spot and TWAP converge) — that must NOT hard-fail the run,
        # because a non-zero exit skips the downstream claim-distribution step and the
        # stock the poke just bought would never reach the broker TBAs. Only flush/poke
        # deferrals (which do strand value / block distribution) are fatal under strict.
        message = "keeper stages deferred: " + ", ".join(failed_actions)
        fatal = [a for a in failed_actions if a != "buyback.execute"]
        if fatal and os.environ.get("KEEPER_STRICT") == "1":
            raise RuntimeError(message)
        print(f"::warning::{message}")


if __name__ == "__main__":
    main()
