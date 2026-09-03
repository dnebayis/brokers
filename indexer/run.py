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

from aggregate import (
    aggregate, buyer_counts, conviction_multiplier, to_basket, coverage, smart_aggregate,
)
from route_preflight import (
    RouteProbeUnavailable, preflight_basket, preflight_enabled, resolve_booster_context,
)
from tokens import address_of
from config import STRATEGY_ID, BPS, MIN_ROUTE_COVERAGE, BOOSTER_ADDRESS, TRAILING_DAYS, wei_env
from health import snapshot_health


def shadow_history_row(divergence, smart_basket, conviction_basket, vetoed, mode, now=None, filed_window=None):
    """One JSONL line of the shadow-vs-live series.

    `live` is always the conviction basket and `shadow` the smart one, regardless of
    which of them was posted; `posted` records that, so the series keeps measuring the
    same two things before and after a SMART_BASKET=live flip.
    """
    now = now or datetime.now(timezone.utc)
    return json.dumps({
        "at": now.isoformat(timespec="seconds"),
        "divergenceBps": divergence,
        "shadow": [{"ticker": s, "bps": w} for s, w in smart_basket],
        "live": [{"ticker": s, "bps": w} for s, w in conviction_basket],
        "posted": "smart" if mode == "live" else "conviction",
        "vetoed": sorted(vetoed),
        # second shadow: the 90-day window keyed on the FILING date instead of the trade date
        "filedWindow": None if filed_window is None else {
            "basket": [{"ticker": s, "bps": w} for s, w in filed_window["basket"]],
            "divergenceBps": filed_window["divergenceBps"],
        },
    }, sort_keys=True)


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
    if not health["ok"] and not args.sample:
        from ops_alerts import alert
        alert("🔴 indexer snapshot health FAILED: " + "; ".join(health["errors"]))
    # Roadmap phase 02 ("an earlier signal") is a measurable claim: report how far the
    # newest filing is behind us. Disclosure dates are day-granular, so the honest unit
    # is days — the hourly cadence bounds OUR added lag to <1h on top of that.
    if health.get("latestDisclosure"):
        try:
            newest = datetime.strptime(str(health["latestDisclosure"])[:10], "%Y-%m-%d")
            lag_days = (datetime.now(timezone.utc).date() - newest.date()).days
            print(f"Ingest lag vs newest disclosure: {lag_days} day(s) (date-granular; our own delay <1h)")
        except ValueError:
            pass

    net = aggregate(trades)
    buyers = buyer_counts(trades)
    basket = to_basket(net, buyers)

    # Filed-window shadow: the same rule keyed on the filing date. Never posted; logged and
    # written to the shadow series so the "which date should the window follow" question
    # is answered with receipts rather than taste.
    filed_basket = to_basket(aggregate(trades, date_key="disclosureDate"), buyer_counts(trades, date_key="disclosureDate"))
    _live_w, _filed_w = dict(basket), dict(filed_basket)
    filed_divergence = sum(abs(_live_w.get(s, 0) - _filed_w.get(s, 0)) for s in set(_live_w) | set(_filed_w)) // 2
    filed_report = {"basket": filed_basket, "divergenceBps": filed_divergence}
    print(f"Filed-window basket [SHADOW (not posted)] — divergence from live: {filed_divergence} bps")
    for s, w in filed_basket:
        print(f"  {s:<6} {w/BPS*100:5.1f}%  ({w} bps, {'+' if w - _live_w.get(s, 0) >= 0 else ''}{w - _live_w.get(s, 0)} vs live)")

    # Smart layer (decay + fast-filer + sell veto), shadow-first: computed and logged on
    # every run so the divergence from the live basket is measurable for weeks before any
    # flip. Only SMART_BASKET=live posts it; shadow changes nothing on chain.
    from config import SMART_BASKET
    shadow_report = None
    if SMART_BASKET != "off":
        # Track-record layer visibility: the member multipliers key on UW's name string,
        # so an upstream name-format change would silently drop the whole layer to 1.0x.
        # One line per run makes that class of breakage observable.
        from aggregate import member_multipliers, _is_buy
        scores = member_multipliers()
        buy_rows = [t for t in trades if _is_buy(t.get("type", ""))]
        matched = sum(1 for t in buy_rows if str(t.get("who", "")).strip().lower() in scores)
        print(f"Track-record match: {matched}/{len(buy_rows)} buy rows carry a member score "
              f"({len(scores)} members in file)")
        if scores and buy_rows and matched == 0:
            from ops_alerts import alert
            alert("⚠️ indexer: track-record layer matched 0 buy rows — "
                  "member name format may have changed upstream; layer is running inert")
        smart_net, vetoed = smart_aggregate(trades)
        smart_basket = to_basket({s: v for s, v in smart_net.items() if s not in vetoed}, buyers)
        # The conviction basket is the "live" column of the shadow series forever: once
        # SMART_BASKET=live reassigns `basket` below, the series would otherwise start
        # comparing the smart basket with itself and the receipts would go blind.
        conviction_basket = list(basket)
        live_w = dict(basket)
        smart_w = dict(smart_basket)
        divergence = sum(abs(live_w.get(s, 0) - smart_w.get(s, 0)) for s in set(live_w) | set(smart_w)) // 2
        shadow_report = {
            "mode": SMART_BASKET,
            "basket": [{"ticker": s, "bps": w} for s, w in smart_basket],
            "vetoed": sorted(vetoed),
            "divergenceBps": divergence,
        }
        label = "LIVE (smart)" if SMART_BASKET == "live" else "SHADOW (not posted)"
        print(f"\nSmart basket [{label}] — divergence from conviction basket: {divergence} bps")
        for s, w in smart_basket:
            delta = w - live_w.get(s, 0)
            print(f"  {s:<6} {w/BPS*100:5.1f}%  ({w} bps, {'+' if delta >= 0 else ''}{delta} vs live)")
        for s in sorted(vetoed):
            if s in live_w:
                print(f"  {s:<6} VETOED — disclosed selling rivals buying; no new money")
        if SMART_BASKET == "live":
            basket = smart_basket

        # Append this run's shadow snapshot to a JSONL history so the shadow-vs-live
        # decision ("weeks of receipts") reads from a series, not from grepping old CI
        # logs. The workflow persists the file across runs via the actions cache.
        history_path = os.environ.get("SHADOW_HISTORY_FILE", "")
        if history_path:
            try:
                with open(history_path, "a") as fh:
                    fh.write(shadow_history_row(
                        divergence, smart_basket, conviction_basket, vetoed, SMART_BASKET,
                        filed_window=filed_report,
                    ) + "\n")
                print(f"  shadow history appended -> {history_path}")
            except OSError as e:
                print(f"::warning::could not append shadow history: {e}")

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
        try:
            basket, dropped = preflight_basket(
                w3, basket, BOOSTER_ADDRESS, buffer_wei, router_address=router_address
            )
        except RouteProbeUnavailable as exc:
            # The RPC failed, not a route. Posting now would mean either dropping legs
            # we never actually tested or trusting a basket the poke may revert on, so
            # the honest move is the same as low coverage: keep the previous epoch and
            # let the next pass retry. Loud, because this is exactly the class of
            # failure that used to look like a clean no-op.
            message = f"route pre-flight unavailable, previous epoch remains active: {exc}"
            print(f"::warning::{message}")
            from ops_alerts import alert
            alert(f"⚠️ indexer: {message}")
            if args.out:
                json.dump({"generatedAt": datetime.now(timezone.utc).isoformat(),
                           "skipped": "route pre-flight unavailable", "reason": str(exc)},
                          open(args.out, "w"), indent=2)
            return
        print(f"\nRoute pre-flight at {buffer_wei / 1e18:.4f} ETH buffer via {router_address}: "
              f"{len(basket)} executable, {len(dropped)} dropped")
        for ticker, bps, reason in dropped:
            print(f"  dropped {ticker} ({bps} bps): {reason}")
        if dropped:
            drop_message = ("route pre-flight dropped " +
                            ", ".join(f"{t} ({r})" for t, _b, r in dropped))
            print(f"::warning::{drop_message}")
            from ops_alerts import alert
            alert(f"⚠️ indexer: {drop_message}")
        preflight_report = {
            "bufferWei": buffer_wei,
            "router": router_address,
            "block": w3.eth.block_number,
            "dropped": [{"ticker": t, "bps": b, "reason": r} for t, b, r in dropped],
        }

    cov = coverage(net, exclude=[t for t, _b, _r in dropped])

    # What is actually eating the coverage. Without this the gate reports a number with no
    # cause, and "expand the universe" stays a guess instead of a list. Names here are the
    # biggest net-bought tickers we cannot route today, largest first.
    from aggregate import is_tokenized

    _skip = {t for t, _b, _r in dropped}
    _pos = {s: v for s, v in net.items() if v > 0}
    _total = sum(_pos.values()) or 1.0
    missed = sorted(
        ((s, v) for s, v in _pos.items() if not is_tokenized(s) or s in _skip),
        key=lambda kv: kv[1], reverse=True,
    )[:15]
    missed_report = [{"ticker": s, "netNotional": v, "shareOfBuying": v / _total} for s, v in missed]

    print(f"\nTokenizable coverage of net buying: {cov*100:.1f}%")
    if missed_report:
        print("Biggest names we cannot route (share of all net buying):")
        for m in missed_report[:8]:
            print(f"  {m['ticker']:<6} {m['shareOfBuying']*100:5.1f}%")
    print(f"Basket ({len(basket)} tickers, weights in bps, sum={sum(w for _,w in basket)}):")
    tickers, weights, addrs = [], [], []
    for tkr, bps in basket:
        addr = address_of(tkr)
        tickers.append(tkr); weights.append(bps); addrs.append(addr)
        pct = bps / BPS * 100
        nb = buyers.get(tkr, 1)
        conv = f"  {nb} members x{conviction_multiplier(nb):.1f}" if nb > 1 else ""
        flag = "" if addr else "  (no on-chain address yet)"
        print(f"  {tkr:<6} {pct:5.1f}%  ({bps} bps){conv}{flag}")

    if not basket:
        print("\nNo eligible tokenizable tickers in window — nothing to post.")
        return

    # Who is behind each name: the same rows, grouped by member, for the site's feed.
    from attribution import attribute
    attribution = attribute(trades, tickers)
    missed_attribution = attribute(trades, [m["ticker"] for m in (missed_report or [])[:5]])
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
        "missedCoverage": missed_report,
        "missedAttribution": missed_attribution,
        "attribution": attribution,
        "smartShadow": shadow_report,
        "filedWindowShadow": {"basket": [{"ticker": t, "bps": w} for t, w in filed_report["basket"]],
                              "divergenceBps": filed_report["divergenceBps"]},
    }
    # A model-written note on the facts above, regenerated only when they change. The
    # previously published note comes from the data branch the site reads, so hourly
    # passes with an unchanged basket reuse it instead of calling the provider.
    from commentary import generate
    previous_note = None
    data_url = os.environ.get("BASKET_DATA_URL", "").strip()
    if data_url:
        try:
            import urllib.request
            with urllib.request.urlopen(urllib.request.Request(
                    data_url, headers={"User-Agent": "coattail-indexer/1.0"}), timeout=30) as r:
                previous_note = (json.load(r) or {}).get("commentary")
        except Exception as exc:  # a missing previous note only costs one model call
            print(f"previous basket note unavailable: {str(exc)[:100]}")
    payload["commentary"] = generate(payload, previous_note, key=os.environ.get("GEMINI_API_KEY", ""))
    if payload["commentary"]:
        print(f"Basket note: {payload['commentary']['text'][:160]}…")
    # Site feed exports (30 days of filings, one record per member), from these same rows.
    if args.out:
        from feed_export import feed_rows, members
        from tokens import ROUTE_READY_ADDRESS
        try:
            scores_raw = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "member-scores.json")))
            scores = scores_raw.get("members", scores_raw) if isinstance(scores_raw, dict) else {}
        except Exception:
            scores = {}
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        base = os.path.dirname(os.path.abspath(args.out)) or "."
        rows = feed_rows(trades, ROUTE_READY_ADDRESS.keys(), tickers)
        json.dump({"generatedAt": stamp, "days": 30, "source": source, "rows": rows}, open(os.path.join(base, "feed-30d.json"), "w"))
        mem = members(trades, ROUTE_READY_ADDRESS.keys(), tickers, scores, days=TRAILING_DAYS)
        json.dump({"generatedAt": stamp, "windowDays": TRAILING_DAYS, "members": mem}, open(os.path.join(base, "members.json"), "w"))
        print(f"Feed export: {len(rows)} filings in 30 days, {len(mem)} members in the window")
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
