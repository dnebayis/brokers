#!/usr/bin/env python3
"""Desk keeper v0: keeps every Desk on the live basket.

Each tick, for every Desk whose owner has not paused the engine:
  1. sells any stock that is no longer in the basket;
  2. on a basket epoch change, sells the part of each name that sits above its new weight;
  3. puts idle USDG (up to the pilot cap) into the names that sit below their weight, with
     one buyStock per name, or one buyBasket when the Desk holds no stock yet;
and flushes the engine's fees (80/20 Booster/treasury as native ETH) once they pass a floor.

Only the difference is traded, so a basket change costs a fraction of a full round trip.
Trades under MIN_TRADE_USD are skipped so the keeper never churns dust.

Used by script/local_env.py (anvil fork, deployer impersonated). On a real network it signs with
the key in KEEPER_KEY_FILE (or KEEPER_KEY); without one it refuses to run anywhere but localhost.
When it owns the test price feeds (testnet), it also re-posts their prices before they go stale:
the engine rejects prices older than 96h and the deposit router older than 24h.

    RPC=https://rpc.testnet.chain.robinhood.com DESK_ADDRESSES=rehearsal/testnet-46630.json \
      KEEPER_KEY_FILE=keeper/.testnet-keeper.json python3 keeper/desk_keeper.py
"""

from __future__ import annotations

import json
import os
import time
import warnings
from dataclasses import dataclass, field
from pathlib import Path

warnings.filterwarnings("ignore")
from eth_account import Account  # noqa: E402
from web3 import Web3  # noqa: E402

DESK = Path(__file__).resolve().parents[1]
E18, E6, BPS = 10**18, 10**6, 10_000
MIN_TRADE_USD = 1.0
FLUSH_MIN_USDG = 5 * E6
FEED_REFRESH_AFTER = 12 * 3600  # well inside the router's 24h window

ERC20 = [{"type": "function", "name": "balanceOf", "stateMutability": "view",
          "inputs": [{"name": "a", "type": "address"}], "outputs": [{"type": "uint256"}]}]
FEED = [{"type": "function", "name": "latestRoundData", "stateMutability": "view", "inputs": [],
         "outputs": [{"type": "uint80"}, {"type": "int256"}, {"type": "uint256"}, {"type": "uint256"},
                     {"type": "uint80"}]},
        {"type": "function", "name": "owner", "stateMutability": "view", "inputs": [], "outputs": [{"type": "address"}]},
        {"type": "function", "name": "setAnswer", "stateMutability": "nonpayable",
         "inputs": [{"name": "a", "type": "int256"}], "outputs": []}]
BOOSTER = [{"type": "function", "name": "stockFeed", "stateMutability": "view",
            "inputs": [{"name": "t", "type": "address"}], "outputs": [{"type": "address"}]}]
REGISTRY = [{"type": "function", "name": "getBasket", "stateMutability": "view",
             "inputs": [{"name": "id", "type": "uint256"}],
             "outputs": [{"type": "address[]"}, {"type": "uint16[]"}, {"type": "uint64"}]}]


def abi(name: str, source: str | None = None) -> list:
    return json.loads((DESK / "out" / f"{source or name}.sol" / f"{name}.json").read_text())["abi"]


def _raw(signed) -> bytes:
    return getattr(signed, "raw_transaction", None) or signed.rawTransaction


@dataclass
class Keeper:
    w3: Web3
    A: dict
    stocks: list[str]
    symbols: dict[str, str]
    log_path: Path | None = None
    seen_epoch: dict[int, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        c = lambda a, x: self.w3.eth.contract(address=Web3.to_checksum_address(a), abi=x)  # noqa: E731
        self.engine = c(self.A["engine"], abi("DeskEngine"))
        self.desks = c(self.A["desks"], abi("DeskNFT"))
        self.registry = c(self.A["registry"], REGISTRY)
        self.booster = c(self.A["booster"], BOOSTER)
        self.usdg = c(self.A["usdg"], ERC20)
        self.eth_feed = c(self.A["ethFeed"], FEED)
        self.acct_abi = abi("DeskAccount")
        self.sid = int(self.A["strategyId"])
        key = os.environ.get("KEEPER_KEY")
        if not key and os.environ.get("KEEPER_KEY_FILE"):
            key = json.loads(Path(os.environ["KEEPER_KEY_FILE"]).read_text())["key"]
        self.signer = Account.from_key(key) if key else None
        if not self.signer:
            rpc = str(self.w3.provider.endpoint_uri)
            if "127.0.0.1" not in rpc and "localhost" not in rpc:
                raise SystemExit("no KEEPER_KEY: the impersonated keeper only runs against a local fork")
        self.sender = self.signer.address if self.signer else Web3.to_checksum_address(self.A["deployer"])

    # --- plumbing ---

    def say(self, msg: str) -> None:
        line = f"{time.strftime('%H:%M:%S')} {msg}"
        print(line, flush=True)
        if self.log_path:
            with self.log_path.open("a") as f:
                f.write(line + "\n")

    def send(self, fn, what: str) -> bool:
        try:
            if self.signer:
                tx = fn.build_transaction({"from": self.sender, "nonce": self.w3.eth.get_transaction_count(self.sender),
                                           "chainId": self.w3.eth.chain_id})
                h = self.w3.eth.send_raw_transaction(_raw(self.signer.sign_transaction(tx)))
            else:
                h = self.w3.eth.send_transaction(fn.build_transaction({"from": self.sender}))
            rc = self.w3.eth.wait_for_transaction_receipt(h, timeout=120, poll_latency=1)
        except Exception as e:  # a revert must not stop the loop; the next tick retries
            self.say(f"  ! {what}: {str(e)[:160]}")
            return False
        ok = rc.status == 1
        self.say(f"  {'✓' if ok else '! reverted'} {what}  (tx {h.hex()[:10]}…)")
        return ok

    def price(self, token: str) -> float:
        feed = self.booster.functions.stockFeed(token).call()
        answer = self.w3.eth.contract(address=feed, abi=FEED).functions.latestRoundData().call()[1]
        return answer / 1e8

    def sym(self, t: str) -> str:
        return self.symbols.get(t.lower(), t[:8])

    # --- one pass ---

    def refresh_feeds(self) -> None:
        """Re-post the same price on test feeds this keeper owns once they are 12h old."""
        feeds = [self.booster.functions.stockFeed(t).call() for t in self.stocks] + [self.A["ethFeed"]]
        now = self.w3.eth.get_block("latest").timestamp
        for addr in feeds:
            feed = self.w3.eth.contract(address=Web3.to_checksum_address(addr), abi=FEED)
            try:
                if feed.functions.owner().call().lower() != self.sender.lower():
                    continue
            except Exception:
                continue  # a real Chainlink feed: nothing to refresh
            _, answer, _, updated, _ = feed.functions.latestRoundData().call()
            if now - updated >= FEED_REFRESH_AFTER:
                self.send(feed.functions.setAnswer(answer), f"refresh feed {addr[:8]}… (${answer / 1e8:,.2f})")

    def tick(self) -> None:
        if self.signer:
            self.refresh_feeds()
        n = self.desks.functions.totalMinted().call()
        tokens, weights, epoch = self.registry.functions.getBasket(self.sid).call()
        weight = {Web3.to_checksum_address(t): w / BPS for t, w in zip(tokens, weights)}
        px = {t: self.price(t) for t in set(self.stocks) | set(weight)}
        fee = self.engine.functions.feeBps().call() / BPS
        for desk_id in range(1, n + 1):
            try:
                self.desk(desk_id, weight, epoch, px, fee)
            except Exception as e:
                self.say(f"desk #{desk_id}: skipped ({str(e)[:120]})")
        fees = self.engine.functions.feesAccrued().call()
        if fees >= FLUSH_MIN_USDG:
            eth_usd = self.eth_feed.functions.latestRoundData().call()[1] / 1e8
            min_out = int(fees / E6 / eth_usd * 0.97 * E18)
            self.say(f"fees {fees / E6:.2f} USDG -> Booster/treasury as ETH")
            self.send(self.engine.functions.flushFees(min_out), "flushFees")

    def desk(self, desk_id: int, weight: dict, epoch: int, px: dict, fee: float) -> None:
        acct = self.desks.functions.accountOf(desk_id).call()
        if self.w3.eth.contract(address=acct, abi=self.acct_abi).functions.enginePaused().call():
            return
        erc = lambda t: self.w3.eth.contract(address=t, abi=ERC20)  # noqa: E731
        bal = lambda: {t: erc(t).functions.balanceOf(acct).call() for t in px}  # noqa: E731
        val = lambda b: {t: b[t] / E18 * px[t] for t in b}  # noqa: E731

        # 1. names that left the basket
        b = bal()
        for t, v in val(b).items():
            if t not in weight and v >= MIN_TRADE_USD:
                self.say(f"desk #{desk_id}: {self.sym(t)} left the basket, selling ${v:,.2f}")
                self.send(self.engine.functions.sellStock(desk_id, t, b[t]), f"sellStock {self.sym(t)}")

        # 2. epoch change: trim what sits above its new weight
        if self.seen_epoch.get(desk_id) != epoch:
            b = bal()
            v = val(b)
            spendable = min(self.usdg.functions.balanceOf(acct).call(),
                            self.engine.functions.capLeftOf(desk_id).call()) / E6
            total = sum(v[t] for t in weight) + spendable
            for t, w in weight.items():
                excess = v[t] - w * total
                if excess >= max(MIN_TRADE_USD, 0.005 * total):
                    amount = min(b[t], int(excess / px[t] * E18))
                    self.say(f"desk #{desk_id}: epoch {epoch}, {self.sym(t)} is ${excess:,.2f} over {w:.0%}, trimming")
                    self.send(self.engine.functions.sellStock(desk_id, t, amount), f"sellStock {self.sym(t)}")
            self.seen_epoch[desk_id] = epoch

        # 3. idle USDG into the names below their weight
        idle = self.usdg.functions.balanceOf(acct).call()
        spend = min(idle, self.engine.functions.capLeftOf(desk_id).call())
        if spend / E6 < MIN_TRADE_USD:
            return
        v = val(bal())
        held = sum(v[t] for t in weight)
        if held < MIN_TRADE_USD:
            self.say(f"desk #{desk_id}: ${spend / E6:,.2f} idle, buying the basket")
            self.send(self.engine.functions.buyBasket(desk_id, spend), "buyBasket")
            return
        total = held + spend / E6 * (1 - fee)
        deficit = {t: max(0.0, w * total - v[t]) for t, w in weight.items()}
        gap = sum(deficit.values())
        if gap <= 0:
            return
        self.say(f"desk #{desk_id}: ${spend / E6:,.2f} idle, filling the names under weight")
        for t, d in sorted(deficit.items(), key=lambda kv: -kv[1]):
            part = int(spend * d / gap)
            if part / E6 >= MIN_TRADE_USD:
                self.send(self.engine.functions.buyStock(desk_id, t, part), f"buyStock {self.sym(t)} ${part / E6:,.2f}")


def load(path: Path) -> tuple[dict, list[str], dict[str, str]]:
    A = json.loads(path.read_text())
    stocks = [Web3.to_checksum_address(A[k]) for k in ("taapl", "tmsft", "tnvda") if k in A]
    symbols = {A["taapl"].lower(): "tAAPL", A.get("tmsft", "").lower(): "tMSFT", A.get("tnvda", "").lower(): "tNVDA"}
    return A, stocks, symbols


if __name__ == "__main__":
    rpc = os.environ.get("RPC", "http://127.0.0.1:8545")
    path = Path(os.environ.get("DESK_ADDRESSES", DESK / "rehearsal" / "local-fork-addresses.json"))
    A, stocks, symbols = load(path)
    # web3 6 sends HTTP requests with no timeout by default: one stalled connection would hang
    # the keeper forever (it did, on its first testnet buy), so every request gets one.
    k = Keeper(Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 30})), A, stocks, symbols,
               log_path=Path(os.environ["KEEPER_LOG"]) if os.environ.get("KEEPER_LOG") else None)
    every = float(os.environ.get("EVERY", "6"))
    k.say(f"desk keeper on {rpc}, every {every:.0f}s")
    while True:
        try:
            k.tick()
        except Exception as e:  # an RPC hiccup must not kill the loop; the next tick retries
            k.say(f"tick failed: {str(e)[:160]}")
        time.sleep(every)
