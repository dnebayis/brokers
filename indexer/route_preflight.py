#!/usr/bin/env python3
"""Live route pre-flight for the Congress basket.

`Booster._poke` buys every basket leg in one atomic transaction. A single route whose
pool has since gone illiquid reverts the whole loop, so no Broker gets anything and the
buffered fees sit until someone notices — that is exactly what SPCX did, and the
route-ready manifest could not catch it because `probeOk` records liquidity at the block
the candidate was *probed*, which may be weeks stale.

This module simulates the real buy at the current block before the basket is signed:
for each leg it `eth_call`s the exact `StockRouter.swapExactETHForStock` the Booster
would execute, with the exact ETH slice `_poke` would send. A leg that cannot fill today
is dropped from the basket rather than posted, so the poke stays executable.

The simulation is read-only and costs no gas.
"""

from __future__ import annotations

import os
import time

BPS = 10_000

ROUTER_ABI = [
    {"type": "function", "name": "swapExactETHForStock", "stateMutability": "payable",
     "inputs": [{"name": "stock", "type": "address"}, {"name": "minOut", "type": "uint256"},
                {"name": "to", "type": "address"}, {"name": "deadline", "type": "uint256"}],
     "outputs": [{"name": "amountOut", "type": "uint256"}]},
]

BOOSTER_ABI = [
    {"type": "function", "name": "router", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "address"}]},
    {"type": "function", "name": "pokeThreshold", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "uint256"}]},
]


def preflight_enabled() -> bool:
    return os.environ.get("ROUTE_PREFLIGHT", "1") == "1"


def resolve_booster_context(w3, booster_address):
    """Return (router_address, poke_threshold_wei) read from the live Booster.

    Reading the router off the Booster (it is `immutable`) guarantees the simulation
    exercises the same contract the poke will, with no address to keep in sync.
    """
    from web3 import Web3

    booster = w3.eth.contract(address=Web3.to_checksum_address(booster_address), abi=BOOSTER_ABI)
    router = Web3.to_checksum_address(booster.functions.router().call())
    threshold = int(booster.functions.pokeThreshold().call())
    return router, threshold


def simulate_leg(w3, router_address, booster_address, stock, wei) -> tuple[bool, int, str]:
    """eth_call one basket leg exactly as `_poke` would send it.

    The Booster normally holds close to nothing between pokes, so the call is made with a
    state override that funds the sender; without it every simulation would fail on
    "insufficient funds" rather than on real route liquidity.
    """
    from web3 import Web3

    router_address = Web3.to_checksum_address(router_address)
    booster_address = Web3.to_checksum_address(booster_address)
    stock = Web3.to_checksum_address(stock)
    router = w3.eth.contract(address=router_address, abi=ROUTER_ABI)
    deadline = int(time.time()) + 600
    overrides = {booster_address: {"balance": hex(wei + 10**18)}}
    try:
        out = router.functions.swapExactETHForStock(stock, 0, booster_address, deadline).call(
            {"from": booster_address, "value": wei}, "latest", overrides
        )
        if int(out) <= 0:
            return False, 0, "route returned zero stock"
        return True, int(out), ""
    except Exception as exc:  # a revert here is the signal, not an error
        return False, 0, str(exc)[:200]


def preflight_basket(w3, basket, booster_address, buffer_wei, router_address=None):
    """Drop basket legs that cannot execute at the current block and renormalise.

    `basket` is the [(ticker, bps)] list from `aggregate.to_basket`, `address_of` maps a
    ticker to its token. Returns (live_basket, dropped) where `dropped` is
    [(ticker, bps, reason)] — an empty `dropped` means the basket is executable as built.
    """
    from tokens import address_of

    if router_address is None:
        router_address, _ = resolve_booster_context(w3, booster_address)

    live, dropped = [], []
    for ticker, bps in basket:
        token = address_of(ticker)
        if not token:
            dropped.append((ticker, bps, "no on-chain address"))
            continue
        slice_wei = (buffer_wei * bps) // BPS
        if slice_wei == 0:
            # `_poke` skips a zero slice, so it can never revert the batch. Keep the leg:
            # it simply buys nothing this round and rounds up on a larger buffer later.
            live.append((ticker, bps))
            continue
        ok, _out, reason = simulate_leg(w3, router_address, booster_address, token, slice_wei)
        if ok:
            live.append((ticker, bps))
        else:
            dropped.append((ticker, bps, reason))
    return renormalise(live), dropped


def renormalise(basket):
    """Rescale weights to sum to exactly BPS after legs were dropped."""
    if not basket:
        return []
    total = sum(bps for _, bps in basket)
    if total == 0:
        return []
    scaled = [(ticker, bps * BPS // total) for ticker, bps in basket]
    drift = BPS - sum(bps for _, bps in scaled)
    ticker0, bps0 = scaled[0]
    scaled[0] = (ticker0, bps0 + drift)  # rounding remainder onto the largest leg
    return scaled
