"""Rialto legs: basket names whose StockRouter route is a RialtoLeg adapter.

Rialto's liquidity (IMC propAMMs) only fills through Rialto's router with calldata its API
builds per trade. For those names the StockRouter route points at a `RialtoLeg` adapter
(contracts/src/RialtoLeg.sol) that expects one API-built quote to be staged in the same
transaction as the poke. This module is everything off-chain that makes that work:

* `leg_for`       is this basket name routed through a RialtoLeg? (reads the live router)
* `size_sell`     how much USDG the adapter will have when the StockRouter calls it
* `quote`         one allowance-settlement quote with the adapter as taker (never logs the key)
* `probe_leg`     the pre-flight equivalent of `simulate_leg` for a Rialto-routed name
* `build_legs`    the `RialtoPokeRunner.run` legs for this hour's poke

Sizing: the Booster wraps the leg's ETH slice and sells it for USDG in the mid pool at
execution time, so the exact USDG is unknown when the quote is requested. The quote sells
the Chainlink-priced slice less a haircut, plus whatever USDG the adapter already carries;
the remainder stays in the adapter as carry and is sold next hour.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

from config import redact

RIALTO_API = os.environ.get("RIALTO_API_BASE", "https://rialto-trade-api.rialto.xyz")
RIALTO_API_KEY = os.environ.get("RIALTO_API_KEY", "")
RIALTO_RUNNER_ADDRESS = os.environ.get("RIALTO_RUNNER_ADDRESS", "")
# Haircut on the Chainlink-priced slice: mid-pool fee plus a few minutes of ETH drift.
RIALTO_SELL_HAIRCUT_BPS = int(os.environ.get("RIALTO_SELL_HAIRCUT_BPS", "100"))
RIALTO_SLIPPAGE_BPS = int(os.environ.get("RIALTO_SLIPPAGE_BPS", "50"))
USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
BPS = 10_000
POOL_KIND_RIALTO = 0

LEG_ABI = [
    {"type": "function", "name": "runner", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "address"}]},
    {"type": "function", "name": "token1", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "address"}]},
    {"type": "function", "name": "carry", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "uint256"}]},
]
ROUTES_ABI = [
    {"type": "function", "name": "routes", "stateMutability": "view",
     "inputs": [{"name": "stock", "type": "address"}],
     "outputs": [{"name": "midPool", "type": "address"}, {"name": "midToken", "type": "address"},
                 {"name": "stockPool", "type": "address"}, {"name": "stockPoolKind", "type": "uint8"},
                 {"name": "midZeroForOne", "type": "bool"}, {"name": "stockZeroForOne", "type": "bool"}]},
]
BOOSTER_FEED_ABI = [
    {"type": "function", "name": "ethUsdFeed", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "address"}]},
    {"type": "function", "name": "minOut", "stateMutability": "view",
     "inputs": [{"name": "tokenOut", "type": "address"}, {"name": "ethIn", "type": "uint256"}],
     "outputs": [{"name": "", "type": "uint256"}]},
]
FEED_ABI = [
    {"type": "function", "name": "latestRoundData", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "roundId", "type": "uint80"}, {"name": "answer", "type": "int256"},
                 {"name": "startedAt", "type": "uint256"}, {"name": "updatedAt", "type": "uint256"},
                 {"name": "answeredInRound", "type": "uint80"}]},
]
RUNNER_ABI = [
    {"type": "function", "name": "run", "stateMutability": "nonpayable",
     "inputs": [{"name": "legs", "type": "tuple[]", "components": [
         {"name": "leg", "type": "address"}, {"name": "data", "type": "bytes"},
         {"name": "sellAmount", "type": "uint256"}]},
         {"name": "maxSpend", "type": "uint256"}],
     "outputs": []},
    {"type": "function", "name": "stagers", "stateMutability": "view",
     "inputs": [{"name": "", "type": "address"}], "outputs": [{"name": "", "type": "bool"}]},
]


class RialtoQuoteError(RuntimeError):
    """The API refused or could not fill the quote; the message never carries the key."""


def leg_for(w3, router_address, stock):
    """Return the RialtoLeg address routing `stock`, or None for v3 / legacy / no route.

    A RialtoLeg is a Rialto-kind route whose pool answers `runner()`; the dead legacy Rialto
    pairs do not, so they stay on the ordinary eth_call path and keep failing loudly there.
    """
    from web3 import Web3

    router = w3.eth.contract(address=Web3.to_checksum_address(router_address), abi=ROUTES_ABI)
    _mid, _mid_token, pool, kind, _mz, _sz = router.functions.routes(Web3.to_checksum_address(stock)).call()
    if int(kind) != POOL_KIND_RIALTO or int(pool, 16) == 0:
        return None
    leg = w3.eth.contract(address=Web3.to_checksum_address(pool), abi=LEG_ABI)
    try:
        leg.functions.runner().call()
    except Exception:  # noqa: BLE001 - a legacy pair has no runner(): not a leg
        return None
    return Web3.to_checksum_address(pool)


def size_sell(slice_wei: int, eth_usd_e8: int, carry_raw: int, haircut_bps: int = RIALTO_SELL_HAIRCUT_BPS) -> int:
    """USDG (6 decimals) the quote sells for one ETH slice: priced at ETH/USD, haircut, plus carry."""
    if slice_wei <= 0 or eth_usd_e8 <= 0:
        return 0
    usd6 = slice_wei * eth_usd_e8 // 10**8 // 10**12
    return usd6 * (BPS - haircut_bps) // BPS + max(int(carry_raw), 0)


def eth_usd_e8(w3, booster_address) -> int:
    from web3 import Web3

    booster = w3.eth.contract(address=Web3.to_checksum_address(booster_address), abi=BOOSTER_FEED_ABI)
    feed_address = booster.functions.ethUsdFeed().call()
    if int(feed_address, 16) == 0:
        raise RialtoQuoteError("Booster has no ETH/USD feed; cannot size a Rialto quote")
    feed = w3.eth.contract(address=Web3.to_checksum_address(feed_address), abi=FEED_ABI)
    _r, answer, _s, _u, _a = feed.functions.latestRoundData().call()
    return int(answer)


def _fetch(url: str, headers: dict) -> dict:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def quote(buy_token: str, sell_raw: int, taker: str, fetch=_fetch, api_key: str | None = None,
          slippage_bps: int = RIALTO_SLIPPAGE_BPS) -> dict:
    """One allowance-settlement quote. Returns {"to", "data", "min_buy", "sell", "buy"}.

    The key travels only in the Authorization header; errors are redacted before they are
    raised so a log line can never leak it.
    """
    key = api_key if api_key is not None else RIALTO_API_KEY
    if not key:
        raise RialtoQuoteError("RIALTO_API_KEY not set")
    if sell_raw <= 0:
        raise RialtoQuoteError("nothing to sell")
    params = urllib.parse.urlencode({
        "sell_token": USDG, "buy_token": buy_token, "taker": taker,
        "sell_amount": f"{sell_raw // 10**6}.{sell_raw % 10**6:06d}",
        "slippage_bps": slippage_bps, "chain_id": 4663, "settlement": "allowance",
    })
    try:
        d = fetch(f"{RIALTO_API}/quote?{params}", {"Authorization": "Bearer " + key, "User-Agent": "coattail-keeper"})
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode()[:200]
        except Exception:  # noqa: BLE001
            pass
        raise RialtoQuoteError(f"quote HTTP {exc.code}: {redact(body)}") from None
    except Exception as exc:  # noqa: BLE001
        raise RialtoQuoteError(f"quote failed: {redact(str(exc))[:200]}") from None
    if d.get("settlement") != "allowance":
        raise RialtoQuoteError(f"quote settlement {d.get('settlement')!r}, wanted allowance")
    issues = d.get("issues") or {}
    spender = ((issues.get("allowance") or {}).get("spender") or d["tx"]["to"]).lower()
    if spender != d["tx"]["to"].lower():
        raise RialtoQuoteError(f"quote spender {spender} differs from tx.to {d['tx']['to']}")
    if int(d["sell_amount"]) != sell_raw:
        raise RialtoQuoteError(f"quote sell {d['sell_amount']} != requested {sell_raw}")
    return {
        "to": d["tx"]["to"], "data": d["tx"]["data"], "min_buy": int(d["min_buy_amount"]),
        "buy": int(d["buy_amount"]), "sell": sell_raw,
    }


def probe_leg(w3, booster_address, leg_address, stock, slice_wei, fetch=_fetch) -> tuple[bool, int, str]:
    """Pre-flight for a Rialto-routed name: (ok, expected_out, reason), like `simulate_leg`.

    The adapter cannot be eth_called unstaged (it reverts NotStaged by design), so the probe
    asks Rialto whether the sized quote fills. The Chainlink comparison happens in the
    caller, exactly as for v3 legs.
    """
    from web3 import Web3

    leg = w3.eth.contract(address=Web3.to_checksum_address(leg_address), abi=LEG_ABI)
    try:
        sell = size_sell(slice_wei, eth_usd_e8(w3, booster_address), int(leg.functions.carry().call()))
        q = quote(stock, sell, leg_address, fetch=fetch)
    except RialtoQuoteError as exc:
        return False, 0, f"rialto: {exc}"
    return True, q["min_buy"], ""


def build_legs(w3, booster_address, router_address, tokens, weights_bps, buffer_wei, fetch=_fetch):
    """Runner legs for this poke: [(leg, data, sell)], plus [(token, reason)] for names that
    are Rialto-routed but could not be quoted (the poke would revert; the caller must defer)."""
    legs, failed = [], []
    price = None
    for token, bps in zip(tokens, weights_bps):
        slice_wei = (int(buffer_wei) * int(bps)) // BPS
        if slice_wei == 0:
            continue
        leg_address = leg_for(w3, router_address, token)
        if not leg_address:
            continue
        try:
            if price is None:
                price = eth_usd_e8(w3, booster_address)
            leg = w3.eth.contract(address=leg_address, abi=LEG_ABI)
            sell = size_sell(slice_wei, price, int(leg.functions.carry().call()))
            q = quote(token, sell, leg_address, fetch=fetch)
        except RialtoQuoteError as exc:
            failed.append((token, str(exc)))
            continue
        legs.append((leg_address, bytes.fromhex(q["data"][2:]), q["sell"]))
    return legs, failed
