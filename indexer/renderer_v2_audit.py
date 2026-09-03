#!/usr/bin/env python3
"""Post-switch audit for BrokerRendererV2.

For a sample of token ids (all rares + a spread + any ids passed on the command line):
  1. what the COLLECTION serves (`CoattailBroker.tokenURI`) must equal `v2.tokenURI` byte for byte
  2. the image inside must equal the image v1 serves (same base64 SVG, compared JSON to JSON)
  3. the seven fixed traits must equal v1's, in order
  4. no live holding may appear as a quoted string; every live holding must be a
     `display_type: number` attribute with a JSON number of at most 4 decimals
Exit code 1 on any mismatch. Read-only.

    RH_RPC_URL=... python3 renderer_v2_audit.py [--all] [--pre] [id ...]

`--pre` audits v2 on its own (checks 2-4) before the owner has switched the collection over.
"""
import base64, json, os, sys, time, subprocess, random

RPC = os.environ.get("RH_RPC_URL", "https://rpc.mainnet.chain.robinhood.com")
BROKER = "0x1122dB21998707F8c2eD8182734356C947fA5e98"
V1 = "0xB1b64E0CE411135DfaB728a482b21981B07fAd31"
V2 = os.environ.get("RENDERER_V2", "0x5b9F2Ee635a05Ee7a3fe245DF80AA37d6865057F")
# v3 = pure attributes (fixed traits only) + `live` object. Set RENDERER_V3 to audit that shape.
V3 = os.environ.get("RENDERER_V3", "")
# v4 = attributes are exactly Type + "Rank band"; the fixed traits move to a `traits` object and
# a `rank` (1..1776) is published. Set RENDERER_V4 to audit that shape.
V4 = os.environ.get("RENDERER_V4", "")
FIXED = ("Type", "Headwear", "Eyes", "Mouth", "Jewelry", "Face", "Accessory")


def call(to, sig, *args):
    for i in range(5):
        p = subprocess.run(["cast", "call", to, sig, *[str(a) for a in args], "--rpc-url", RPC],
                           capture_output=True, text=True)
        if p.returncode == 0:
            return p.stdout.strip()
        time.sleep(2 * (i + 1))
    raise SystemExit(f"rpc failed: {sig} {args}: {p.stderr[:200]}")


def token_json(uri):
    assert uri.startswith("data:application/json;base64,"), uri[:60]
    return json.loads(base64.b64decode(uri.split(",", 1)[1]))


def main():
    pre = "--pre" in sys.argv
    args = [a for a in sys.argv[1:] if a not in ("--all", "--pre")]
    ids = [405, 1176, 178, 311, 1648, 1684, 1, 2, 100, 500, 742, 1000, 1500, 1776]
    ids += [int(a) for a in args]
    if "--all" in sys.argv:
        ids = list(range(1, 1777))
    else:
        random.seed(7)
        ids += random.sample(range(1, 1777), 20)
    ids = sorted(set(ids))

    target = V4 or V3 or V2
    pure = bool(V3) and not V4
    live_renderer = call(BROKER, "renderer()(address)")
    tag = "V4" if V4 else ("V3" if pure else "V2")
    print(f"collection renderer = {live_renderer}  ({tag if live_renderer.lower()==target.lower() else 'NOT '+tag})")
    bad = 0
    for tid in ids:
        v2 = call(target, "tokenURI(uint256)(string)", tid).strip('"')
        if not pre:
            served = call(BROKER, "tokenURI(uint256)(string)", tid).strip('"')
            if served != v2:
                print(f"#{tid}: collection tokenURI != {tag}.tokenURI"); bad += 1; continue
        j = token_json(v2)
        v1_json = token_json(call(V1, "tokenURI(uint256)(string)", tid).strip('"'))
        if j["image"] != v1_json["image"]:
            print(f"#{tid}: image differs from v1"); bad += 1
        fixed_v1 = [(a["trait_type"], a["value"]) for a in v1_json["attributes"] if a["trait_type"] in FIXED]
        if V4:
            kinds = [a["trait_type"] for a in j["attributes"]]
            if kinds != ["Type", "Rank band"]:
                print(f"#{tid}: attributes must be exactly Type + Rank band, got {kinds}"); bad += 1
            if j["attributes"][0]["value"] != fixed_v1[0][1]:
                print(f"#{tid}: Type differs from v1"); bad += 1
            traits = j.get("traits", {})
            if [(k, v) for k, v in traits.items()] != fixed_v1:
                print(f"#{tid}: traits object differs from v1 fixed traits {fixed_v1} vs {traits}"); bad += 1
            rank = j.get("rank", 0)
            if not (isinstance(rank, int) and 1 <= rank <= 1776):
                print(f"#{tid}: rank missing or out of range: {rank}"); bad += 1
            if "live" not in j or "status" not in j["live"]: print(f"#{tid}: live object missing"); bad += 1
            time.sleep(0.4)
            continue
        fixed_v2 = [(a["trait_type"], a["value"]) for a in j["attributes"] if a["trait_type"] in FIXED]
        if fixed_v1 != fixed_v2:
            print(f"#{tid}: fixed traits differ {fixed_v1} vs {fixed_v2}"); bad += 1
        if pure:
            extra = [a["trait_type"] for a in j["attributes"] if a["trait_type"] not in FIXED]
            if extra: print(f"#{tid}: non-trait attributes leaked: {extra}"); bad += 1
            if "live" not in j or "status" not in j["live"]: print(f"#{tid}: live object missing"); bad += 1
            time.sleep(0.4)
            continue
        for a in j["attributes"]:
            t = a["trait_type"]
            if t in FIXED or t == "Status":
                if not isinstance(a["value"], str): print(f"#{tid}: {t} not a string"); bad += 1
                continue
            if a.get("display_type") != "number" or not isinstance(a["value"], (int, float)):
                print(f"#{tid}: live attr {t} is not a number attribute: {a}"); bad += 1
            elif isinstance(a["value"], float) and round(a["value"], 4) != a["value"]:
                print(f"#{tid}: {t} has more than 4 decimals: {a['value']}"); bad += 1
        time.sleep(0.4)
    print(f"checked {len(ids)} ids, problems: {bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
