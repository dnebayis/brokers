#!/usr/bin/env python3
"""Coattail Brokers indexer — build The Politician basket and (optionally) post it.

    python run.py --sample            # run on bundled sample data (no API key)
    python run.py                     # fetch live from FMP (needs FMP_API_KEY)
    python run.py --out basket.json   # also write the basket to JSON
    python run.py --post              # post to StrategyRegistry (needs chain env)
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

from aggregate import aggregate, to_basket, coverage
from route_preflight import preflight_basket, preflight_enabled, resolve_booster_context
from tokens import address_of
from config import STRATEGY_ID, BPS, MIN_ROUTE_COVERAGE, BOOSTER_ADDRESS, wei_env
from health import snapshot_health


def _load_trades(sample: bool):
    if sample:
        path = os.path.join(os.path.dirname(__file__), "sample.json")
        return "sample", json.load(open(path))
    from sources import fetch_live
    return fetch_live()


def _post_onchain(strategy_id, tokens, weights, force=False):
    """Sign the basket EIP-712 and relay it via StrategyRegistry.setStrategyWithSig.

    The signing key (UPDATER_PRIVATE_KEY) must equal the on-chain `oracleSigner`.
    Authorization is the signature, so any funded account may relay; we relay from
    the same key for simplicity. Arrays are committed as packed keccak digests,
    matching the contract exactly.
    """
    from web3 import Web3
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    from config import STRATEGY_REGISTRY, UPDATER_PRIVATE_KEY, CHAIN_ID, make_web3
    if not (STRATEGY_REGISTRY and UPDATER_PRIVATE_KEY):
        raise RuntimeError("Set STRATEGY_REGISTRY_ADDRESS and UPDATER_PRIVATE_KEY to post")
    if any(a is None for a in tokens):
        raise RuntimeError("Some tickers have no on-chain address (fill tokens.ADDRESS)")

    w3 = make_web3()
    acct = w3.eth.account.from_key(UPDATER_PRIVATE_KEY)
    registry = Web3.to_checksum_address(STRATEGY_REGISTRY)
    check = [Web3.to_checksum_address(a) for a in tokens]

    abi = [
        {"type": "function", "name": "epochOf", "stateMutability": "view",
         "inputs": [{"name": "strategyId", "type": "uint256"}],
         "outputs": [{"name": "", "type": "uint64"}]},
        {"type": "function", "name": "getBasket", "stateMutability": "view",
         "inputs": [{"name": "strategyId", "type": "uint256"}],
         "outputs": [
             {"name": "tokens", "type": "address[]"},
             {"name": "weightsBps", "type": "uint16[]"},
             {"name": "epoch", "type": "uint64"},
         ]},
        {"type": "function", "name": "setStrategyWithSig", "stateMutability": "nonpayable",
         "inputs": [
             {"name": "strategyId", "type": "uint256"},
             {"name": "tokens", "type": "address[]"},
             {"name": "weightsBps", "type": "uint16[]"},
             {"name": "epoch", "type": "uint64"},
             {"name": "deadline", "type": "uint256"},
             {"name": "signature", "type": "bytes"},
         ], "outputs": []},
    ]
    c = w3.eth.contract(address=registry, abi=abi)

    current_tokens, current_weights, current_epoch = c.functions.getBasket(strategy_id).call()
    same = (
        [a.lower() for a in current_tokens] == [a.lower() for a in check]
        and list(current_weights) == list(weights)
    )
    if same and not force:
        print(f"  unchanged from on-chain epoch {current_epoch}; no transaction sent")
        return None

    epoch = int(c.functions.epochOf(strategy_id).call()) + 1  # strictly monotonic
    deadline = w3.eth.get_block("latest")["timestamp"] + 3600

    # Array commitments must match the contract: keccak256(abi.encodePacked(tokens/weightsBps)).
    # NOTE: Solidity's abi.encodePacked pads *array elements* to 32 bytes (unlike standalone
    # value types, which pack tightly) — so each address and each uint16 is 32 bytes here.
    tokens_hash = Web3.keccak(b"".join(bytes(12) + bytes.fromhex(a[2:]) for a in check))
    weights_hash = Web3.keccak(b"".join(int(x).to_bytes(32, "big") for x in weights))

    typed = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "Update": [
                {"name": "strategyId", "type": "uint256"},
                {"name": "tokensHash", "type": "bytes32"},
                {"name": "weightsHash", "type": "bytes32"},
                {"name": "epoch", "type": "uint64"},
                {"name": "deadline", "type": "uint256"},
            ],
        },
        "domain": {
            "name": "CoattailStrategyRegistry", "version": "1",
            "chainId": CHAIN_ID, "verifyingContract": registry,
        },
        "primaryType": "Update",
        "message": {
            "strategyId": strategy_id, "tokensHash": tokens_hash,
            "weightsHash": weights_hash, "epoch": epoch, "deadline": deadline,
        },
    }
    signed_msg = Account.sign_message(encode_typed_data(full_message=typed), UPDATER_PRIVATE_KEY)
    signature = bytes(signed_msg.signature)

    tx = c.functions.setStrategyWithSig(
        strategy_id, check, weights, epoch, deadline, signature
    ).build_transaction({
        "from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address, "pending"),
        "chainId": CHAIN_ID,
    })
    signed = acct.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
    h = w3.eth.send_raw_transaction(raw)
    receipt = w3.eth.wait_for_transaction_receipt(h, timeout=180)
    if receipt.status != 1:
        raise RuntimeError(f"setStrategy transaction reverted: {h.hex()}")
    print(f"  signed epoch {epoch}, deadline {deadline}")
    return h.hex()


def _post_role_onchain(strategy_id, tokens, weights, force=False):
    """Ops fallback: post via the role-gated `setStrategy` (UPDATER_ROLE), no signature.

    Use when the relaying key holds UPDATER_ROLE. The EIP-712 `setStrategyWithSig` path
    (_post_onchain) is the production default; this is a convenience for keys with the role.
    """
    from web3 import Web3
    from config import STRATEGY_REGISTRY, UPDATER_PRIVATE_KEY, CHAIN_ID, make_web3
    if not (STRATEGY_REGISTRY and UPDATER_PRIVATE_KEY):
        raise RuntimeError("Set STRATEGY_REGISTRY_ADDRESS and UPDATER_PRIVATE_KEY to post")
    if any(a is None for a in tokens):
        raise RuntimeError("Some tickers have no on-chain address (fill tokens.ADDRESS)")

    w3 = make_web3()
    acct = w3.eth.account.from_key(UPDATER_PRIVATE_KEY)
    registry = Web3.to_checksum_address(STRATEGY_REGISTRY)
    check = [Web3.to_checksum_address(a) for a in tokens]
    abi = [
        {"type": "function", "name": "setStrategy", "stateMutability": "nonpayable",
         "inputs": [{"name": "strategyId", "type": "uint256"},
                    {"name": "tokens", "type": "address[]"},
                    {"name": "weightsBps", "type": "uint16[]"}], "outputs": []},
        {"type": "function", "name": "getBasket", "stateMutability": "view",
         "inputs": [{"name": "strategyId", "type": "uint256"}],
         "outputs": [{"name": "tokens", "type": "address[]"},
                     {"name": "weightsBps", "type": "uint16[]"},
                     {"name": "epoch", "type": "uint64"}]},
    ]
    c = w3.eth.contract(address=registry, abi=abi)
    current_tokens, current_weights, current_epoch = c.functions.getBasket(strategy_id).call()
    same = (
        [a.lower() for a in current_tokens] == [a.lower() for a in check]
        and list(current_weights) == list(weights)
    )
    if same and not force:
        print(f"  unchanged from on-chain epoch {current_epoch}; no transaction sent")
        return None
    tx = c.functions.setStrategy(strategy_id, check, weights).build_transaction({
        "from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address, "pending"), "chainId": CHAIN_ID,
    })
    signed = acct.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
    tx_hash = w3.eth.send_raw_transaction(raw)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    if receipt.status != 1:
        raise RuntimeError(f"setStrategy transaction reverted: {tx_hash.hex()}")
    return tx_hash.hex()


def main():
    p = argparse.ArgumentParser(description="Coattail Brokers — Politician basket indexer")
    p.add_argument("--sample", action="store_true", help="use bundled sample.json (no API key)")
    p.add_argument("--out", type=str, default=None, help="write basket JSON to this path")
    p.add_argument("--post", action="store_true", help="post to StrategyRegistry on-chain (EIP-712 signed)")
    p.add_argument("--role", action="store_true", help="post via role-gated setStrategy instead of a signature")
    p.add_argument("--force-post", action="store_true", help="post even when the on-chain basket is identical")
    p.add_argument(
        "--allow-sample-post",
        action="store_true",
        help="testnet only: allow the bundled deterministic fixture to exercise signed posting",
    )
    args = p.parse_args()

    source, trades = _load_trades(args.sample)
    health = snapshot_health(trades)
    print(f"Loaded {len(trades)} congressional trade rows"
          f" from {source}.")
    print(
        f"Snapshot health: {'PASS' if health['ok'] else 'FAIL'} — "
        f"{health['distinctTraders']} traders, latest={health['latestDisclosure'] or 'unknown'}"
    )
    for error in health["errors"]:
        print(f"  health: {error}")

    net = aggregate(trades)
    basket = to_basket(net)

    # A poke buys every leg atomically, so one illiquid route reverts the whole batch and
    # nothing reaches any Broker. Simulate each leg against the live pools before signing
    # and drop whatever cannot fill today; the manifest's probeOk flag only records
    # liquidity at probe time and goes stale silently.
    dropped: list[tuple[str, int, str]] = []
    preflight_report = None
    if preflight_enabled() and BOOSTER_ADDRESS and not args.sample:
        from config import make_web3

        w3 = make_web3()
        router_address, poke_threshold = resolve_booster_context(w3, BOOSTER_ADDRESS)
        buffer_wei = wei_env("ROUTE_PREFLIGHT_BUFFER_WEI", str(poke_threshold))
        basket, dropped = preflight_basket(
            w3, basket, BOOSTER_ADDRESS, buffer_wei, router_address=router_address
        )
        print(f"\nRoute pre-flight at {buffer_wei / 1e18:.4f} ETH buffer via {router_address}: "
              f"{len(basket)} executable, {len(dropped)} dropped")
        for ticker, bps, reason in dropped:
            print(f"  dropped {ticker} ({bps} bps): {reason}")
        if dropped:
            print("::warning::route pre-flight dropped " +
                  ", ".join(f"{t} ({r})" for t, _b, r in dropped))
        preflight_report = {
            "bufferWei": buffer_wei,
            "router": router_address,
            "block": w3.eth.block_number,
            "dropped": [{"ticker": t, "bps": b, "reason": r} for t, b, r in dropped],
        }

    cov = coverage(net, exclude=[t for t, _b, _r in dropped])

    print(f"\nTokenizable coverage of net buying: {cov*100:.1f}%")
    print(f"Basket ({len(basket)} tickers, weights in bps, sum={sum(w for _,w in basket)}):")
    tickers, weights, addrs = [], [], []
    for tkr, bps in basket:
        addr = address_of(tkr)
        tickers.append(tkr); weights.append(bps); addrs.append(addr)
        pct = bps / BPS * 100
        flag = "" if addr else "  (no on-chain address yet)"
        print(f"  {tkr:<6} {pct:5.1f}%  ({bps} bps){flag}")

    if not basket:
        print("\nNo eligible tokenizable tickers in window — nothing to post.")
        return

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "health": health,
        "coverage": cov,
        "strategyId": STRATEGY_ID,
        "tickers": tickers,
        "tokens": addrs,
        "weightsBps": weights,
        "routePreflight": preflight_report,
    }
    if args.out:
        json.dump(payload, open(args.out, "w"), indent=2)
        print(f"\nWrote basket -> {args.out}")

    if args.post:
        if cov < MIN_ROUTE_COVERAGE:
            # A safe operational decision, not a crash: keep the last valid epoch and
            # skip this post. Warn (so it is visible) rather than failing the scheduled
            # run. INDEXER_STRICT=1 restores hard-fail.
            message = (f"route-ready net-notional coverage {cov:.2%} is below required "
                       f"{MIN_ROUTE_COVERAGE:.2%}; previous epoch remains active")
            if os.environ.get("INDEXER_STRICT") == "1":
                raise RuntimeError("Refusing on-chain post: " + message)
            print(f"::warning::Skipping on-chain post: {message}")
            return None
        if not health["ok"] and not args.sample:
            raise RuntimeError("Refusing on-chain post: source snapshot failed health gates")
        if args.sample and not args.allow_sample_post:
            raise RuntimeError("Refusing on-chain post from bundled sample data")
        if args.sample:
            from config import NETWORK
            if NETWORK != "testnet":
                raise RuntimeError("--allow-sample-post is restricted to NETWORK=testnet")
        try:
            txh = (
                _post_role_onchain(STRATEGY_ID, addrs, weights, args.force_post)
                if args.role
                else _post_onchain(STRATEGY_ID, addrs, weights, args.force_post)
            )
            if txh:
                print(f"\nPosted {'setStrategy' if args.role else 'setStrategyWithSig'} tx: {txh}")
            else:
                print("\nNo-op: canonical basket has not changed.")
        except Exception as e:
            print(f"\nPost failed: {e}", file=sys.stderr)
            raise


if __name__ == "__main__":
    main()
