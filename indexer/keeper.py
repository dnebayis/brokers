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

from config import redact  # noqa: E402
from config import (
    BROKER_ADDRESS,
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
        print(json.dumps({"action": "poke.diagnosis", "status": "unavailable", "error": redact(str(exc))[:200]}))



MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
_MC3_ABI = [{
    "type": "function", "name": "aggregate3", "stateMutability": "payable",
    "inputs": [{"name": "calls", "type": "tuple[]", "components": [
        {"name": "target", "type": "address"},
        {"name": "allowFailure", "type": "bool"},
        {"name": "callData", "type": "bytes"}]}],
    "outputs": [{"name": "returnData", "type": "tuple[]", "components": [
        {"name": "success", "type": "bool"}, {"name": "returnData", "type": "bytes"}]}],
}]


def _mc_call(w3, calls, chunk=150):
    """Batch many view calls through Multicall3. `calls` are (contract, fn_name, args).

    Valuing Brokers one field at a time meant ~1,400 sequential round trips for 164 enrolled
    playbooks, which took over three minutes and would only get worse. Batching keeps the
    stage flat as enrolment grows. Failures come back as None rather than raising, so one
    unreadable token cannot blank the run.
    """
    from web3 import Web3

    mc = w3.eth.contract(address=Web3.to_checksum_address(MULTICALL3), abi=_MC3_ABI)
    out = []
    for i in range(0, len(calls), chunk):
        part = calls[i:i + chunk]
        # web3 renamed these between 6.x and 7.x and requirements.txt pins only ">=6",
        # so support both rather than breaking on whichever the runner resolves.
        def _encode(contract, fn, args):
            if hasattr(contract, "encode_abi"):
                try:
                    return contract.encode_abi(fn, args=list(args))
                except TypeError:
                    return contract.encode_abi(abi_element_identifier=fn, args=list(args))
            return contract.encodeABI(fn_name=fn, args=list(args))

        def _decode(contract, fn, data):
            if hasattr(contract, "decode_function_result"):
                return contract.decode_function_result(fn, data)
            # web3 6.x has no per-contract decoder: fall back to the ABI codec, using the
            # output types declared for this function.
            from eth_abi import decode as abi_decode

            entry = next(
                a for a in contract.abi
                if a.get("type") == "function" and a.get("name") == fn
            )
            types = [o["type"] for o in entry.get("outputs", [])]
            return abi_decode(types, bytes(data))

        payload = [(c[0].address, True, _encode(c[0], c[1], c[2])) for c in part]
        try:
            res = mc.functions.aggregate3(payload).call()
        except Exception as exc:
            # A rate-limited RPC and unreadable data look identical downstream ("unpriced");
            # one line per failed chunk keeps the cause visible.
            print(json.dumps({"action": "multicall", "status": "chunk_failed",
                              "calls": len(part), "error": redact(str(exc))[:160]}))
            out.extend([None] * len(part))
            continue
        for (contract, fn, _args), (ok, data) in zip(part, res):
            if not ok:
                out.append(None)
                continue
            try:
                decoded = _decode(contract, fn, data)
                out.append(decoded[0] if len(decoded) == 1 else decoded)
            except Exception:
                out.append(None)
    return out



def _have_want(message):
    """Parse the node's 'insufficient funds ... have X want Y' into ints, else (None, None)."""
    import re
    m = re.search(r"have (\d+) want (\d+)", message)
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


def _shrink_batch(size, have, want, floor=5):
    """Largest batch the relay can carry: scale by have/want with a 15% margin, never
    below `floor` (a batch that small is sent as-is and left to the node's verdict)."""
    if size <= floor or want <= 0 or have >= want:
        return size
    return max(floor, min(size - 1, int(size * have / want * 0.85)))


def _holdings_floor_usdg_many(ctx, token_ids):
    """Chainlink-floored USDG value for many Brokers at once. Returns {token_id: value|None}.

    Counts what is already in the Broker wallet AND what the Booster still owes it
    (claimable): a playbook's first step is the claim, so the order can move both, and
    gating on the wallet alone made an order wait for the weekly sweep to land the stock
    before its earnings even counted toward the threshold.
    """
    if ctx is None or not token_ids:
        return {}
    w3 = ctx["w3"]
    from web3 import Web3

    tbas = _mc_call(w3, [(ctx["brokers"], "accountOf", (tid,)) for tid in token_ids])
    pairs, meta = [], []
    for tid, tba in zip(token_ids, tbas):
        if not tba:
            continue
        # the raw ABI decoder hands back lowercase addresses; web3 rejects those downstream
        tba = Web3.to_checksum_address(tba)
        for stock in ctx["stocks"]:
            pairs.append((stock, "balanceOf", (tba,)))
            meta.append((tid, stock))
    balances = _mc_call(w3, pairs)
    quote_calls, quote_meta = [], []
    for (tid, stock), bal in zip(meta, balances):
        if bal:
            quote_calls.append((ctx["floor"], "minUsdgOut", (stock.address, int(bal))))
            quote_meta.append(tid)
    owed = _mc_call(w3, [(ctx["booster"], "claimable", (tid,)) for tid in token_ids])
    for tid, row in zip(token_ids, owed):
        if row is None:
            continue
        for stock_addr, amt in zip(row[0], row[1]):
            if int(amt) > 0:
                quote_calls.append((ctx["floor"], "minUsdgOut", (Web3.to_checksum_address(stock_addr), int(amt))))
                quote_meta.append(tid)
    quotes = _mc_call(w3, quote_calls)
    worth = {tid: (0 if tba else None) for tid, tba in zip(token_ids, tbas)}
    for tid, q in zip(quote_meta, quotes):
        if q is None:
            # A leg we cannot price (stale feed, dead quote) makes the whole valuation
            # unusable: summing only the legs that DID quote would understate the wallet
            # and could push a partially-priced Broker past the gate into a doomed order.
            worth[tid] = None
            continue
        if worth.get(tid) is not None:
            worth[tid] += int(q)
    return worth


def _pb_context(w3, engine, floor_addr):
    """Everything the per-Broker valuation needs that is identical for every Broker.

    Read once per run: the stock list alone was 9 calls per Broker, which turned a 25-order
    batch into hundreds of sequential round trips and made the stage the slowest thing in
    the keeper. Returns None when the venue is not configured.
    """
    from web3 import Web3

    if not floor_addr:
        return None
    try:
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
        booster = w3.eth.contract(address=Web3.to_checksum_address(engine.functions.booster().call()), abi=[
            {"type": "function", "name": "knownTokenCount", "stateMutability": "view",
             "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
            {"type": "function", "name": "knownTokens", "stateMutability": "view",
             "inputs": [{"name": "i", "type": "uint256"}],
             "outputs": [{"name": "", "type": "address"}]},
            {"type": "function", "name": "ethUsdFeed", "stateMutability": "view",
             "inputs": [], "outputs": [{"name": "", "type": "address"}]},
            {"type": "function", "name": "ethUsdManualE8", "stateMutability": "view",
             "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
            {"type": "function", "name": "claimable", "stateMutability": "view",
             "inputs": [{"name": "tokenId", "type": "uint256"}],
             "outputs": [{"name": "tokens", "type": "address[]"},
                         {"name": "amounts", "type": "uint256[]"}]},
            {"type": "function", "name": "isActive", "stateMutability": "view",
             "inputs": [{"name": "tokenId", "type": "uint256"}],
             "outputs": [{"name": "", "type": "bool"}]},
        ])
        erc20 = [{"type": "function", "name": "balanceOf", "stateMutability": "view",
                  "inputs": [{"name": "a", "type": "address"}],
                  "outputs": [{"name": "", "type": "uint256"}]},
                 {"type": "function", "name": "decimals", "stateMutability": "view",
                  "inputs": [], "outputs": [{"name": "", "type": "uint8"}]}]
        stocks = [booster.functions.knownTokens(i).call()
                  for i in range(int(booster.functions.knownTokenCount().call()))]
        return {
            "w3": w3,
            "brokers": w3.eth.contract(address=Web3.to_checksum_address(engine.functions.brokers().call()), abi=[
                {"type": "function", "name": "ownerOf", "stateMutability": "view",
                 "inputs": [{"name": "tokenId", "type": "uint256"}],
                 "outputs": [{"name": "", "type": "address"}]},
                {"type": "function", "name": "accountOf", "stateMutability": "view",
                 "inputs": [{"name": "tokenId", "type": "uint256"}],
                 "outputs": [{"name": "", "type": "address"}]},
            ]),
            "booster": booster,
            "floor": floor,
            "stocks": [w3.eth.contract(address=t, abi=erc20) for t in stocks],
            "fee_bps": int(floor.functions.feeBps().call()),
            "usdg_dec": int(w3.eth.contract(address=floor.functions.usdg().call(), abi=erc20)
                            .functions.decimals().call()),
        }
    except Exception as exc:
        # Without this context every playbook order is "unpriced" for the whole pass, so
        # the reason must not be silent.
        print(json.dumps({"action": "playbooks.context", "status": "unavailable",
                          "error": redact(str(exc))[:160]}))
        return None


def _holdings_floor_usdg(ctx, token_id):
    """Chainlink-floored USDG value of what a Broker's wallet holds, or None if unreadable."""
    if ctx is None:
        return None
    try:
        tba = ctx["brokers"].functions.accountOf(token_id).call()
        total = 0
        for stock in ctx["stocks"]:
            bal = int(stock.functions.balanceOf(tba).call())
            if bal:
                total += int(ctx["floor"].functions.minUsdgOut(stock.address, bal).call())
        return total
    except Exception:
        return None


def _coat_min_out(ctx, token_id):
    """Minimum $COAT a TO_COAT playbook must deliver, or None if it cannot be priced.

    Mirrors what the venue will actually do: the Chainlink-floored value of the holdings,
    minus the Floor's fee, converted to ETH at the Booster's own ETH/USD source, then to
    COAT at CoatRouter's spot. The spot view excludes the hooked pool's fee, so 2% comes off
    for the pool and 1% more for ordinary drift before the transaction is mined.
    """
    if ctx is None:
        return None
    try:
        # Same measure as the run gate: wallet stock AND what the Booster still owes (the
        # engine claims first, so the swap moves both). Pricing the wallet alone let a mostly
        # claimable order pass the gate with a minOut sized for a fraction of what it swaps.
        floor_usdg = _holdings_floor_usdg_many(ctx, [token_id]).get(token_id)
        if not floor_usdg:
            return None
        net = floor_usdg * (10_000 - ctx["fee_bps"]) // 10_000
        feed = ctx["booster"].functions.ethUsdFeed().call()
        if int(feed, 16) != 0:
            eth_usd8 = int(ctx["w3"].eth.contract(address=feed, abi=[
                {"type": "function", "name": "latestRoundData", "stateMutability": "view",
                 "inputs": [], "outputs": [
                     {"name": "a", "type": "uint80"}, {"name": "answer", "type": "int256"},
                     {"name": "c", "type": "uint256"}, {"name": "d", "type": "uint256"},
                     {"name": "e", "type": "uint80"}]},
            ]).functions.latestRoundData().call()[1])
        else:
            eth_usd8 = int(ctx["booster"].functions.ethUsdManualE8().call())
        if eth_usd8 <= 0:
            return None
        eth_wei = net * 10 ** 8 * 10 ** 18 // (10 ** ctx["usdg_dec"] * eth_usd8)
        eth_wei = eth_wei * 99 // 100
        coat_spot = int(ctx["w3"].eth.contract(
            address=ctx["floor"].functions.coatRouter().call(), abi=[
                {"type": "function", "name": "quoteBuy", "stateMutability": "view",
                 "inputs": [{"name": "ethIn", "type": "uint256"}],
                 "outputs": [{"name": "", "type": "uint256"}]},
            ]).functions.quoteBuy(eth_wei).call())
        guard = coat_spot * 98 // 100 * 99 // 100
        return guard if guard > 0 else None
    except Exception:
        return None



GIFT_VAULT_ABI = [
    {"type": "function", "name": "open", "stateMutability": "view", "inputs": [], "outputs": [
        {"name": "nft", "type": "address"}, {"name": "id", "type": "uint256"},
        {"name": "drawBlock", "type": "uint64"}, {"name": "openedAt", "type": "uint64"}]},
    {"type": "function", "name": "lastGiftAt", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "uint64"}]},
    {"type": "function", "name": "interval", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "uint64"}]},
    {"type": "function", "name": "queuedCount", "stateMutability": "view", "inputs": [],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"type": "function", "name": "openRound", "stateMutability": "nonpayable", "inputs": [], "outputs": []},
    {"type": "function", "name": "settle", "stateMutability": "nonpayable", "inputs": [], "outputs": []},
]


def gift_plan(now: int, last_gift_at: int, interval: int, queued: int, open_nft: str) -> str:
    """What the gift stage should do this pass: 'settle' an open round, 'open' the next one,
    or stay 'idle'. Pure so the cadence logic is testable without a chain.

    A round that is already open always comes first (its NFT is out of the queue and waits
    for nothing but the draw block). A new round needs something queued and the announced
    interval to have elapsed since the last gift; the contract enforces both as well, this
    only avoids paying for a guaranteed revert.
    """
    if open_nft and int(open_nft, 16) != 0:
        return "settle"
    if queued <= 0:
        return "idle"
    if last_gift_at and now < last_gift_at + interval:
        return "idle"
    return "open"

def _feed_watchdog(w3) -> None:
    """Alert when a stock feed misses an update it should have made.

    The on-chain staleness guard was widened to 96h (owner decision, community vote) so
    weekends trade at Friday's close. That guard used to double as a tripwire for a feed
    breaking mid-week; this watchdog replaces that lost tripwire off-chain. Thresholds by
    New York weekday: Sat/Sun are expected-stale (skip), Monday tolerates the weekend
    backlog (70h), Tue-Fri anything past 30h means a trading day passed with no update.
    A market-holiday Tuesday can false-alarm once; noise beats a four-day blind spot.
    """
    import os
    from zoneinfo import ZoneInfo
    booster_addr = os.environ.get("BOOSTER_ADDRESS", "")
    if not booster_addr:
        return
    try:
        from web3 import Web3
        ny = datetime.now(ZoneInfo("America/New_York"))
        wd = ny.weekday()  # Mon=0 .. Sun=6
        if wd >= 5:
            return
        limit_h = 70 if wd == 0 else 30
        booster = w3.eth.contract(address=Web3.to_checksum_address(booster_addr), abi=[
            {"type": "function", "name": "knownTokenCount", "stateMutability": "view",
             "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
            {"type": "function", "name": "knownTokens", "stateMutability": "view",
             "inputs": [{"name": "i", "type": "uint256"}],
             "outputs": [{"name": "", "type": "address"}]},
            {"type": "function", "name": "stockFeed", "stateMutability": "view",
             "inputs": [{"name": "t", "type": "address"}],
             "outputs": [{"name": "", "type": "address"}]},
        ])
        feed_abi = [{"type": "function", "name": "latestRoundData", "stateMutability": "view",
                     "inputs": [], "outputs": [
                         {"name": "roundId", "type": "uint80"},
                         {"name": "answer", "type": "int256"},
                         {"name": "startedAt", "type": "uint256"},
                         {"name": "updatedAt", "type": "uint256"},
                         {"name": "answeredInRound", "type": "uint80"}]}]
        now = int(datetime.now(timezone.utc).timestamp())
        laggards = []
        for i in range(int(booster.functions.knownTokenCount().call())):
            token = booster.functions.knownTokens(i).call()
            feed = booster.functions.stockFeed(token).call()
            if int(feed, 16) == 0:
                continue
            updated = int(w3.eth.contract(address=feed, abi=feed_abi)
                          .functions.latestRoundData().call()[3])
            age_h = (now - updated) / 3600
            if age_h > limit_h:
                laggards.append(f"{token[:10]}… {age_h:.0f}h")
        if laggards:
            from ops_alerts import alert
            message = (f"stock feed watchdog: {len(laggards)} feed(s) past the {limit_h}h "
                       f"expected-update window on a trading day — " + "; ".join(laggards))
            print(f"::warning::{message}")
            alert(f"🩺 {message}")
    except Exception as exc:  # the watchdog must never break the keeper it watches
        print(json.dumps({"action": "feed.watchdog", "status": "skipped", "error": redact(str(exc))[:160]}))



# Selector of Booster.BelowThreshold(uint256 have, uint256 need): the buffer is below the poke
# threshold. After a poke that reverted on chain it means an earlier poke (ours or anyone's,
# poke() is permissionless) already spent the buffer, so nothing is stuck and nothing was lost.
BELOW_THRESHOLD_SELECTOR = "0x8b05c814"


def is_below_threshold(reason: str) -> bool:
    text = (reason or "").lower()
    return BELOW_THRESHOLD_SELECTOR in text or "belowthreshold" in text


def simulate_reason(call, sender: str) -> str:
    """Replay a contract call as eth_call and return its revert text ("" if it passes now)."""
    try:
        call.call({"from": sender})
        return ""
    except Exception as exc:  # noqa: BLE001 - the message is the diagnosis
        return redact(str(exc))


def send_signed(w3, account, call, gas_limit: int, label: str, chain_id: int,
                sleep: Callable[[float], None] = time.sleep, tries: int = 4):
    """Broadcast `call` from `account` and return the hash of the transaction in flight.

    RH's proxied RPC can serve a stale nonce and can answer a broadcast with an error after
    the transaction was in fact accepted. A naive "bump the nonce and resend" then sends the
    same action twice: the first lands, the copy reverts (seen twice on 2026-09-03 as
    booster.poke pairs at nonces 5196/5197 and 5207/5208, the copy reverting BelowThreshold
    and failing the keeper pass). The hash of a signed transaction is known before broadcast,
    so on a send error this looks for that hash on the node first and only bumps the nonce
    when the transaction is truly absent. Every broadcast attempt is logged with its hash.
    """
    nonce = max(
        w3.eth.get_transaction_count(account.address, "pending"),
        w3.eth.get_transaction_count(account.address, "latest"),
    )
    for send_try in range(tries):
        tx = call.build_transaction({
            "from": account.address,
            "nonce": nonce,
            "chainId": chain_id,
            "gas": gas_limit,
        })
        signed = account.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        local_hash = getattr(signed, "hash", None) or w3.keccak(raw)
        try:
            tx_hash = w3.eth.send_raw_transaction(raw)
            print(json.dumps({"action": label, "status": "sent", "tx": tx_hash.hex(), "nonce": nonce}))
            return tx_hash
        except Exception as exc:
            # Accepted despite the error? Then that IS our transaction; never send a copy.
            for _ in range(3):
                try:
                    if w3.eth.get_transaction(local_hash) is not None:
                        print(json.dumps({"action": label, "status": "sent", "tx": local_hash.hex(),
                                          "nonce": nonce, "note": f"accepted despite send error: {redact(str(exc))[:120]}"}))
                        return local_hash
                except Exception:  # noqa: BLE001 - not found / RPC hiccup: keep looking
                    pass
                sleep(1)
            if "nonce" in redact(str(exc)).lower() and send_try < tries - 1:
                print(json.dumps({"action": label, "status": "resend", "nonce": nonce, "error": redact(str(exc))[:160]}))
                nonce = max(nonce + 1, w3.eth.get_transaction_count(account.address, "latest"))
                continue
            raise
    raise RuntimeError(f"{label}: could not broadcast after {tries} attempts")


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
    _feed_watchdog(w3)
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
    # An empty fee plan (no swap this hour) is not a reason to stop: the Floor flush, Playbooks
    # and the gift draw below are gated on their own state, and skipping them here made a due
    # gift draw or a runnable order wait for the next hour that happened to have a $COAT swap.
    if not args.execute:
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
            # Nonce recovery without duplicate sends lives in send_signed (see its docstring).
            tx_hash = send_signed(w3, account, call, gas_limit, label, CHAIN_ID)
            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
            if receipt.status != 1:
                # Name the reason instead of a bare "status 0"; and a poke that lost the race to an
                # earlier poke (ours or anyone's) spent nothing but the reverted tx's gas: the buffer
                # is already stock. That is not a deferral, the next pass has nothing to retry.
                reason = simulate_reason(call, account.address)
                if label == "booster.poke" and is_below_threshold(reason):
                    print(json.dumps({"action": label, "status": "raced", "tx": tx_hash.hex(),
                                      "note": "buffer already spent by an earlier poke"}))
                    return True
                raise RuntimeError(f"receipt status {receipt.status}: {reason[:200]}" if reason
                                   else f"receipt status {receipt.status}")
            print(json.dumps({"action": label, "status": "success", "tx": tx_hash.hex()}))
            return True
        except Exception as exc:
            # Stages are intentionally isolated: a temporarily unavailable buyback
            # TWAP must not prevent fee flushing or stock purchases, and vice versa.
            print(json.dumps({"action": label, "status": "deferred", "error": redact(str(exc))}))
            failed_actions.append(label)
            failed_errors[label] = redact(str(exc))
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
                              "error": f"pre-flight revert: {redact(str(exc))[:200]}"}))
            failed_actions.append("booster.poke")
            failed_errors["booster.poke"] = f"pre-flight revert: {redact(str(exc))[:300]}"
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
            print(json.dumps({"action": "floor.flush", "status": "deferred", "error": redact(str(exc))[:200]}))

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
                # the valuation helpers below read these two off the engine, so they must be
                # in this ABI or every order silently prices as None and waits forever
                {"type": "function", "name": "brokers", "stateMutability": "view",
                 "inputs": [], "outputs": [{"name": "", "type": "address"}]},
                {"type": "function", "name": "booster", "stateMutability": "view",
                 "inputs": [], "outputs": [{"name": "", "type": "address"}]},
                {"type": "function", "name": "keeper", "stateMutability": "view",
                 "inputs": [], "outputs": [{"name": "", "type": "address"}]},
                {"type": "function", "name": "setterOf", "stateMutability": "view",
                 "inputs": [{"name": "tokenId", "type": "uint256"}],
                 "outputs": [{"name": "", "type": "address"}]},
            ])
            pb_batch = int(os.environ.get("PLAYBOOKS_MAX_BATCH", "25"))
            total = int(engine.functions.enrolledCount().call())
            ids, min_outs = [], []
            # Scan window. Always starting at index 0 would starve everyone past the batch
            # size forever: enrolment order is fixed, so entry 26 would never be reached. The
            # window rotates with the hour instead, so every enrolled Broker comes up.
            relay_for_preflight = engine.functions.keeper().call()
            pb_ctx = _pb_context(w3, engine, floor_addr)
            scan = min(total, int(os.environ.get("PLAYBOOKS_MAX_SCAN", "200")))
            start = 0
            if total > scan:
                start = (datetime.now(timezone.utc).hour * scan) % total
            # Running a playbook costs ~1M gas; a Broker earns cents an hour. Converting
            # every hour would burn far more gas than the salary is worth, so an order only
            # runs once the Broker's wallet is worth moving. Note this gate skips the WHOLE
            # order, the claim included — the claim is the playbook's first step, not a
            # separate stage — so a below-threshold Broker is claimed by the weekly
            # ClaimSweeper pass or by the holder's own one-click claim, exactly like a
            # Broker with no playbook at all. Nothing is lost either way: unclaimed
            # earnings sit in the Booster's accounting under that Broker's id.
            min_usdg_env = float(os.environ.get("PLAYBOOKS_MIN_USDG", "5"))
            window = [int(x) for x in _mc_call(
                w3, [(engine, "enrolledAt", ((start + o) % total,)) for o in range(scan)]) if x is not None]
            modes = _mc_call(w3, [(engine, "playbookOf", (tid,)) for tid in window])
            # A playbook dies silently when the Broker changes hands (the engine checks
            # setter == current owner and returns). Dead entries stay enrolled, so without
            # this filter the keeper pays for a guaranteed no-op on them every single hour.
            dead_ids = set()
            if pb_ctx is not None:
                setters = _mc_call(w3, [(engine, "setterOf", (tid,)) for tid in window])
                owners = _mc_call(w3, [(pb_ctx["brokers"], "ownerOf", (tid,)) for tid in window])
                for tid, s, o in zip(window, setters, owners):
                    if s is not None and o is not None and str(s).lower() != str(o).lower():
                        dead_ids.add(tid)
            worth_by_id = _holdings_floor_usdg_many(
                pb_ctx, [tid for tid, m in zip(window, modes)
                         if m is not None and int(m[1]) != 0 and tid not in dead_ids])
            # NONE-mode playbooks exist only for their auto-claim; running one with nothing
            # claimable is a paid no-op (observed: ~137k gas, zero logs, every single hour).
            # Value the claim first and only carry orders that will actually move stock.
            claimable_by_id = {}
            if pb_ctx is not None:
                claim_ids = [tid for tid, m in zip(window, modes)
                             if m is not None and int(m[1]) == 0 and bool(m[0]) and not bool(m[3])
                             and tid not in dead_ids]
                actives = _mc_call(w3, [(pb_ctx["booster"], "isActive", (tid,)) for tid in claim_ids])
                for tid, row, act in zip(claim_ids, _mc_call(
                        w3, [(pb_ctx["booster"], "claimable", (tid,)) for tid in claim_ids]), actives):
                    if act is not None and not act:
                        # the engine only claims for ACTIVE Brokers; an inactive one is a
                        # guaranteed no-op regardless of what claimable() reports
                        claimable_by_id[tid] = 0
                        continue
                    claimable_by_id[tid] = None if row is None else sum(int(a) for a in row[1])
            for token_id, mode_row in zip(window, modes):
                if len(ids) >= pb_batch:
                    break
                if mode_row is None:
                    continue
                mode = int(mode_row[1])
                if bool(mode_row[3]):
                    continue  # paused: the engine returns immediately, don't spend gas on it
                if token_id in dead_ids:
                    print(json.dumps({"action": "playbooks.run", "tokenId": token_id,
                                      "status": "skipped",
                                      "reason": "playbook died on transfer; new owner must re-enroll"}))
                    continue
                if mode == 0:
                    # Auto-claim-only order. Without autoClaim it can never do anything;
                    # with nothing claimable it is a no-op this hour. Skip both, retry
                    # next run — unclaimed earnings sit safely in the Booster meanwhile.
                    if not bool(mode_row[0]):
                        continue
                    if pb_ctx is not None:
                        owed = claimable_by_id.get(token_id)
                        if owed is not None and owed == 0:
                            continue
                    ids.append(token_id)
                    min_outs.append(0)
                    continue
                if mode != 0:
                    worth = worth_by_id.get(token_id)
                    min_usdg_raw = int(min_usdg_env * 10 ** (pb_ctx["usdg_dec"] if pb_ctx else 6))
                    if worth is None:
                        print(json.dumps({"action": "playbooks.run", "tokenId": token_id,
                                          "status": "unpriced",
                                          "note": "holdings could not be valued; retrying next run"}))
                        continue
                    if worth < min_usdg_raw:
                        print(json.dumps({"action": "playbooks.run", "tokenId": token_id,
                                          "status": "waiting", "worthRaw": worth,
                                          "minRaw": min_usdg_raw}))
                        continue
                if mode == 3:
                    # TO_COAT crosses the hooked pool, which has no Chainlink floor of its
                    # own, so the guard has to be computed here: Chainlink floors of the
                    # Broker's holdings -> ETH at the Booster's own price -> COAT at spot,
                    # then haircut for the pool's fee and normal drift. A quote we cannot
                    # compute means we skip that order rather than send an unguarded zero.
                    guard = _coat_min_out(pb_ctx, token_id)
                    if guard is None:
                        print(json.dumps({"action": "playbooks.run", "tokenId": token_id,
                                          "status": "skipped", "reason": "no COAT quote"}))
                        continue
                    ids.append(token_id)
                    min_outs.append(guard)
                    continue
                ids.append(token_id)
                min_outs.append(0)
            # One order that cannot fill (a dead route, a guard the market moved past) would
            # revert the whole transaction and take every other holder's order down with it.
            # Simulate each one free first and carry only the ones that pass, exactly as the
            # poke stage does. A dropped order is reported and retried next hour.
            healthy_ids, healthy_mins = [], []
            for token_id, guard in zip(ids, min_outs):
                try:
                    engine.functions.run([token_id], [guard]).call({"from": relay_for_preflight})
                    healthy_ids.append(token_id)
                    healthy_mins.append(guard)
                except Exception as exc:
                    print(json.dumps({"action": "playbooks.run", "tokenId": token_id,
                                      "status": "deferred", "reason": redact(str(exc))[:160]}))
            if healthy_ids:
                # A big batch needs its whole gas budget up front, and an unaffordable one
                # used to defer EVERY order in the pass. Send what the relay can carry now:
                # shrink by the have/want ratio the node reports, floor of 5, and keep
                # going with the remainder as long as sends succeed.
                pending_ids, pending_mins = list(healthy_ids), list(healthy_mins)
                size = len(pending_ids)
                while pending_ids:
                    b_ids, b_mins = pending_ids[:size], pending_mins[:size]
                    try:
                        est = int(engine.functions.run(b_ids, b_mins).estimate_gas({"from": account.address}))
                        gas_limit = max(est * 2, 500_000 + 700_000 * len(b_ids))
                        have = int(w3.eth.get_balance(account.address))
                        want = gas_limit * int(w3.eth.gas_price)
                    except Exception as exc:
                        have, want = _have_want(redact(str(exc)))
                        if have is None:
                            # not an affordability problem: let submit report it the normal way
                            have, want = 1, 1
                    new_size = _shrink_batch(size, have, want)
                    if new_size < size:
                        print(json.dumps({"action": "playbooks.run", "status": "resized",
                                          "from": size, "to": new_size}))
                        size = new_size
                        continue
                    if not submit("playbooks.run",
                                  lambda b_ids=b_ids, b_mins=b_mins: engine.functions.run(b_ids, b_mins),
                                  min_gas=500_000 + 700_000 * len(b_ids)):
                        break
                    pending_ids, pending_mins = pending_ids[size:], pending_mins[size:]
            else:
                print(json.dumps({"action": "playbooks.run", "status": "skipped",
                                  "enrolled": total, "eligible": len(ids)}))
        except Exception as exc:  # standing orders defer to the next hour, never break payroll
            print(json.dumps({"action": "playbooks.run", "status": "deferred", "error": redact(str(exc))[:200]}))

    # Gift vault: one donated NFT to a random ACTIVE Broker every `interval` seconds. The
    # winner comes from a block hash the contract picks; the keeper only opens the round and
    # settles it once that block exists. Same env-gating as the other periphery stages.
    gift_addr = os.environ.get("GIFT_VAULT", "").strip()
    if gift_addr:
        try:
            vault = w3.eth.contract(address=Web3.to_checksum_address(gift_addr), abi=GIFT_VAULT_ABI)

            def _open_round():
                return vault.functions.open().call()

            def _settle_round() -> bool:
                # `block.number` inside the EVM on this chain is the L1 (Ethereum) block
                # number, not the L2 height the RPC reports, so the draw block is ~20 L1
                # blocks (~4 min) ahead and its hash stays readable for ~256 L1 blocks
                # (~50 min). Comparing the RPC's L2 height against it is meaningless: the
                # only reliable readiness check is simulating settle() until it stops
                # reverting. A stale hash re-rolls the round on chain; allow two more tries.
                for _attempt in range(3):
                    r = _open_round()
                    if int(r[0], 16) == 0:
                        return True
                    deadline = time.time() + 8 * 60
                    ready = False
                    while time.time() < deadline:
                        try:
                            vault.functions.settle().call({"from": account.address})
                            ready = True
                            break
                        except Exception as exc:
                            if "484e399a" not in redact(str(exc)) and "DrawBlockNotReached" not in redact(str(exc)):
                                reason = redact(str(exc))[:160]
                                print(json.dumps({"action": "gift.settle", "status": "deferred",
                                                  "error": reason}))
                                # Not a timing revert: this round cannot be settled at all. The
                                # vault takes any ERC-721, so an item whose transfer reverts jams
                                # the draw until the owner cancels or rescues it, and the queue
                                # keeps its place. Say so instead of deferring quietly every hour.
                                from ops_alerts import alert as _alert
                                _alert(f"🎁 gift round stuck (nft {r[0]} #{int(r[1])}): {reason}")
                                return False
                        time.sleep(15)
                    if not ready:
                        print(json.dumps({"action": "gift.settle", "status": "deferred",
                                          "error": "draw block not reached within 8 min"}))
                        return False
                    if not submit("gift.settle", lambda: vault.functions.settle(), min_gas=400_000):
                        return False
                r = _open_round()
                return int(r[0], 16) == 0

            now_ts = int(datetime.now(timezone.utc).timestamp())
            last_gift = int(vault.functions.lastGiftAt().call())
            gift_interval = int(vault.functions.interval().call())
            queued = int(vault.functions.queuedCount().call())
            current = _open_round()
            # The queue accepts any collection. A round holding something other than a Broker
            # is either a gift someone sent us or an attempt to jam the draw; either way the
            # owner should hear about it the first pass it is open.
            expected_nft = str(BROKER_ADDRESS or "")
            if current[0] and int(current[0], 16) != 0 and expected_nft \
                    and current[0].lower() != expected_nft.lower():
                from ops_alerts import alert as _alert
                print(json.dumps({"action": "gift.open", "status": "foreign-nft",
                                  "nft": current[0], "id": int(current[1])}))
                _alert(f"🎁 gift round holds a non-Broker NFT: {current[0]} #{int(current[1])} "
                       "(cancelRound puts it back at the tail; rescue removes it)")
            action = gift_plan(now_ts, last_gift, gift_interval, queued, current[0])
            if action == "settle":
                _settle_round()
            elif action == "open":
                if submit("gift.open", lambda: vault.functions.openRound(), min_gas=300_000):
                    _settle_round()
            else:
                print(json.dumps({"action": "gift.open", "status": "skipped", "queued": queued,
                                  "nextDrawAt": (last_gift + gift_interval) if last_gift else 0}))
        except Exception as exc:  # a gift never blocks payroll stages
            print(json.dumps({"action": "gift.open", "status": "deferred", "error": redact(str(exc))[:200]}))

    if failed_actions:
        # Stages are isolated by design: a deferred stage retries next run and never
        # strands funds. `buyback.execute` legitimately defers early (SpotTooFarFromTwap
        # while the fresh pool's spot and TWAP converge) — that must NOT hard-fail the run,
        # because a non-zero exit skips the downstream claim-distribution step and the
        # stock the poke just bought would never reach the broker TBAs. Only flush/poke
        # deferrals (which do strand value / block distribution) are fatal under strict.
        message = "keeper stages deferred: " + ", ".join(failed_actions)
        fatal = [a for a in failed_actions
                 if a not in ("buyback.execute", "floor.flush", "playbooks.run", "gift.open", "gift.settle")]
        # NOTE: there used to be a weekend exemption here that downgraded a BadFeed
        # (0xb0171a5d) poke deferral to a warning, because the 24h staleness guard
        # tripped every weekend by design. The guard is 96h now (owner txs, community
        # vote): weekends are inside the window and trade at Friday's close, so any
        # BadFeed at any time means a feed genuinely missed its updates (or a market
        # holiday stretched past four days, which is rare enough to want the alarm).
        if fatal and os.environ.get("KEEPER_STRICT") == "1":
            from ops_alerts import alert
            alert("🔴 keeper FAILED — " + message + " | " +
                  "; ".join(f"{a}: {str(failed_errors.get(a, ''))[:120]}" for a in fatal))
            raise RuntimeError(message)
        print(f"::warning::{message}")


if __name__ == "__main__":
    main()
