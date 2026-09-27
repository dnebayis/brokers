#!/usr/bin/env python3
"""Local Desk lab: an anvil fork of Robinhood Chain testnet with every Desk contract deployed,
funded test wallets, and the keeper running. The site's /desk-lab page talks to it.

    cd desk && python3 script/local_env.py [--fund 0xYourMetaMaskAddress ...]

Then, in another terminal:  cd frontend && NEXT_PUBLIC_DESK_LAB=1 npm run dev  -> /desk-lab
Change the basket while it runs:  python3 keeper/desk_basket.py set tAAPL=70 tMSFT=30

Everything lives on the fork at http://127.0.0.1:8545 (chain id 46630, same as testnet);
nothing reaches the real testnet. Ctrl-C stops anvil and the keeper.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
from eth_account import Account  # noqa: E402
from web3 import Web3  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "keeper"))
from desk_keeper import Keeper, load  # noqa: E402

DESK = Path(__file__).resolve().parents[1]
FRONTEND_JSON = DESK.parent / "frontend" / "public" / "desk-local.json"
ADDRESSES = DESK / "rehearsal" / "local-fork-addresses.json"
KEEPER_LOG = DESK / "rehearsal" / "keeper.log"
FORK_URL = os.environ.get("TESTNET_RPC", "https://rpc.testnet.chain.robinhood.com")
PORT = 8545
RPC = f"http://127.0.0.1:{PORT}"
DEPLOYER = Web3.to_checksum_address("0x9e643731dc9D8795573Aa34C410664407FfDC440")
E18, E6 = 10**18, 10**6
MINT = [{"type": "function", "name": "mint", "stateMutability": "nonpayable",
         "inputs": [{"name": "to", "type": "address"}, {"name": "v", "type": "uint256"}], "outputs": []},
        {"type": "function", "name": "transfer", "stateMutability": "nonpayable",
         "inputs": [{"name": "to", "type": "address"}, {"name": "v", "type": "uint256"}], "outputs": [{"type": "bool"}]}]


def fund(w3: Web3, A: dict, who: str) -> None:
    who = Web3.to_checksum_address(who)
    w3.provider.make_request("anvil_setBalance", [who, hex(10 * E18)])
    coat = w3.eth.contract(address=Web3.to_checksum_address(A["coat"]), abi=MINT)
    usdg = w3.eth.contract(address=Web3.to_checksum_address(A["usdg"]), abi=MINT)
    for fn in (coat.functions.transfer(who, 500_000 * E18), usdg.functions.mint(who, 5_000 * E6)):
        w3.eth.wait_for_transaction_receipt(w3.eth.send_transaction(fn.build_transaction({"from": DEPLOYER})))
    print(f"  funded {who}: 10 ETH, 500,000 COAT, 5,000 tUSDG")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fund", nargs="*", default=[], help="extra wallet addresses to fund (e.g. MetaMask)")
    ap.add_argument("--every", type=float, default=6.0, help="keeper interval, seconds")
    args = ap.parse_args()

    anvil = subprocess.Popen(
        ["anvil", "--fork-url", FORK_URL, "--port", str(PORT), "--auto-impersonate", "--silent"],
        preexec_fn=os.setsid,
    )
    try:
        w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 120}))
        for _ in range(120):
            try:
                if w3.is_connected() and w3.eth.chain_id == 46630:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            print("anvil did not come up")
            return 1
        fork_block = w3.eth.block_number
        print(f"anvil fork of testnet at {RPC}, block {fork_block:,}")
        w3.provider.make_request("anvil_setBalance", [DEPLOYER, hex(100 * E18)])

        print("deploying the desk contracts (forge script, deployer impersonated)…")
        env = dict(os.environ, DESK_TREASURY=DEPLOYER, DESK_OUT=str(ADDRESSES.relative_to(DESK)))
        p = subprocess.run(["forge", "script", "script/DeployDeskTestnet.s.sol", "--rpc-url", RPC, "--broadcast",
                            "--unlocked", "--sender", DEPLOYER, "--slow"], cwd=DESK, env=env,
                           capture_output=True, text=True)
        if p.returncode != 0:
            print(p.stdout[-2000:], p.stderr[-2000:])
            return 1
        A, stocks, symbols = load(ADDRESSES)

        test_wallet = Account.create().address  # anvil impersonates it; no key needed
        print("funding wallets…")
        for who in [test_wallet, *args.fund]:
            fund(w3, A, who)

        FRONTEND_JSON.write_text(json.dumps({
            "rpc": RPC, "chainId": 46630, "forkBlock": fork_block, "testWallet": test_wallet, "deployer": DEPLOYER,
            "symbols": {A["taapl"]: "tAAPL", A["tmsft"]: "tMSFT", A["tnvda"]: "tNVDA"},
            **{k: v for k, v in A.items()},
        }, indent=2))
        print(f"page config -> {FRONTEND_JSON.relative_to(DESK.parent)}")
        KEEPER_LOG.write_text("")
        k = Keeper(w3, A, stocks, symbols, log_path=KEEPER_LOG)
        k.say(f"keeper running every {args.every:.0f}s (log: {KEEPER_LOG.relative_to(DESK.parent)})")
        print("ready. open /desk-lab with NEXT_PUBLIC_DESK_LAB=1 npm run dev (frontend). Ctrl-C to stop.", flush=True)
        while True:
            try:
                k.tick()
            except Exception as e:
                k.say(f"tick failed: {str(e)[:160]}")
            time.sleep(args.every)
    except KeyboardInterrupt:
        return 0
    finally:
        os.killpg(os.getpgid(anvil.pid), signal.SIGTERM)


if __name__ == "__main__":
    sys.exit(main())
