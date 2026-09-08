#!/usr/bin/env python3
"""Compare two projects' VERIFIED on-chain sources, token by token.

Fetches exact-match sources from Sourcify (chain 4663, Robinhood Chain) for the Coattail
Brokers contracts and the StonkBrokers contracts, strips comments, tokenises, and reports:

  * identifier overlap (function / event / error / struct / contract names) after removing
    the ERC-20 / ERC-721 / OpenZeppelin names every Solidity project shares,
  * 8-token shingle overlap per file (the standard code-clone measure): how much of each
    Coattail file appears anywhere in the StonkBrokers sources, and the best-matching file,
  * what the shared shingles actually are (import lines and `address(0)` checks, in practice),
  * how much each project's ERC-6551 account borrows from the public EIP-6551 reference.

No API keys, no local sources: everything comes from Sourcify and the EIP text, so anyone
can re-run it.  Usage:  python3 compare_verified_sources.py [--markdown]
"""
import json
import os
import re
import sys
import urllib.request

CHAIN = 4663
SOURCIFY = "https://sourcify.dev/server/v2/contract/{chain}/{addr}?fields=sources,compilation,deployment"
EIP6551 = "https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-6551.md"

COATTAIL = {
    "CoattailBroker": "0x1122dB21998707F8c2eD8182734356C947fA5e98",
    "BrokerAccount": "0x32A055D504840E69B7a0B2136264EEF643f6312C",
    "Booster": "0x7bAf435847A4b45c2e22a7fd13549C3192C95953",
    "StockRouter": "0x99F3f896B58bcb8A515ED3C7174c017B5a55075a",
    "StrategyRegistry": "0xA20f9D47E0c41e52a57d65feA9A9322732aF86Aa",
    "FeeSplitter": "0x8cE36Fa4aa2d934cA6aD7bE9de31a8eeFeDf8aE8",
    "COAT": "0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833",
    "CoatFeeHook": "0x51149a925E9193EA13Ae406Da6Cc154EccD0A044",
    "BasketRouter": "0x478F22A32663cF37702d65352A7579A73e61FDc7",
}
STONKBROKERS = {
    "StonkBrokers (NFT)": "0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0",
    "StonkBroker6551Account": "0xe946075125843aadb5e40e59f513d929af507c4b",
    "ERC6551Registry (vendored)": "0x28c154cbdeaecbf5f72b6ae48535ab9a431a4161",
    "Renderer": "0x2a2fc76d9cb0e5d2bdb2ba6b236b6e7ef264b186",
    "ActivationManager": "0xacd5ae3c060c1137fe2ee86b0ab2ef697456f664",
    "DirectedClockInBooster": "0x1f12fe622c11947f93f53d63f68f7f46b6d081c9",
    "StonkNFTAMMVault (Anvil)": "0xe302733accf4800146e55fc45b46b4e4ffc032d2",
    "StonkLoanVault": "0xa7b9ac696b252b79568a5a01b2fd02177ef23664",
    "TokenEscrowReserve": "0x799ae26fa515cef145e8bc8636f7fff87b05cf62",
    "CollectionToken (STONKBROKER)": "0xe934e36a439c94017b64a3fece66af12099abf50",
}
# Names every ERC-20 / ERC-721 / OpenZeppelin-based project has; not evidence of anything.
STANDARD = set(
    """transfer transferFrom approve balanceOf ownerOf tokenURI totalSupply name symbol decimals
    supportsInterface safeTransferFrom setApprovalForAll getApproved isApprovedForAll owner
    renounceOwnership transferOwnership acceptOwnership pendingOwner constructor receive fallback
    onERC721Received royaltyInfo mint burn pause unpause paused execute isValidSigner
    isValidSignature token state Transfer Approval ApprovalForAll OwnershipTransferred
    OwnershipTransferStarted Paused Unpaused""".split()
)


def fetch(addr):
    with urllib.request.urlopen(SOURCIFY.format(chain=CHAIN, addr=addr), timeout=90) as r:
        return json.load(r)


def own_sources(d):
    """Only the project's own files: libraries (OpenZeppelin, forge-std) are shared by everyone."""
    out = {}
    for path, src in (d.get("sources") or {}).items():
        if path.startswith("lib/") or "openzeppelin" in path or "forge-std" in path or "node_modules" in path:
            continue
        out[path] = src["content"] if isinstance(src, dict) else src
    return out


def strip(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def tokens(src):
    return re.findall(r"[A-Za-z_]\w*|\d+|[^\s\w]", strip(src))


def shingles(toks, k=8):
    return set(tuple(toks[i : i + k]) for i in range(max(0, len(toks) - k + 1)))


def idents(src):
    s = strip(src)
    return {
        "functions": set(re.findall(r"\bfunction\s+([A-Za-z_]\w*)", s)),
        "events": set(re.findall(r"\bevent\s+([A-Za-z_]\w*)", s)),
        "errors": set(re.findall(r"\berror\s+([A-Za-z_]\w*)", s)),
        "structs": set(re.findall(r"\bstruct\s+([A-Za-z_]\w*)", s)),
        "contracts": set(re.findall(r"\b(?:contract|interface|library)\s+([A-Za-z_]\w*)", s)),
    }


def load(project):
    files, meta = {}, []
    for label, addr in project.items():
        d = fetch(addr)
        comp, dep = d.get("compilation") or {}, d.get("deployment") or {}
        srcs = own_sources(d)
        for p, s in srcs.items():
            files[f"{label} :: {os.path.basename(p)}"] = s
        meta.append((label, addr, d.get("match"), comp.get("compilerVersion"), dep.get("blockNumber"), len(srcs)))
    return files, meta


def aggregate(files):
    agg = {k: set() for k in ("functions", "events", "errors", "structs", "contracts")}
    for s in files.values():
        for k, v in idents(s).items():
            agg[k] |= v
    return agg


def main():
    md = "--markdown" in sys.argv
    ours, ours_meta = load(COATTAIL)
    theirs, theirs_meta = load(STONKBROKERS)
    h = (lambda t: print(f"\n## {t}\n")) if md else (lambda t: print(f"\n== {t}"))

    h("verified sources fetched from Sourcify (chain 4663)")
    for name, meta in (("Coattail Brokers", ours_meta), ("StonkBrokers", theirs_meta)):
        print(f"{name}:")
        for label, addr, match, comp, block, n in meta:
            print(f"  {label:<30} {addr}  {match:<12} solc {comp}  block {block}  files {n}")

    h("identifier overlap (standard ERC / OpenZeppelin names removed)")
    A, B = aggregate(ours), aggregate(theirs)
    for k in A:
        a, b = A[k] - STANDARD, B[k] - STANDARD
        shared = sorted(a & b)
        print(f"  {k:<10} coattail {len(a):<4} stonkbrokers {len(b):<4} shared {len(shared):<3} {shared}")

    h("8-token shingle overlap, per Coattail file")
    tsh = {f: shingles(tokens(s)) for f, s in theirs.items()}
    all_theirs = set().union(*tsh.values())
    shared_all = set()
    for f, s in sorted(ours.items()):
        o = shingles(tokens(s))
        if not o:
            continue
        best = max(tsh.items(), key=lambda kv: len(kv[1] & o) / max(1, len(kv[1] | o)))
        jac = len(best[1] & o) / max(1, len(best[1] | o))
        shared_all |= o & all_theirs
        print(f"  {f:<44} found-in-stonkbrokers {len(o & all_theirs) / len(o):6.1%}   best match {best[0].split(' :: ')[1]:<34} jaccard {jac:6.2%}")

    h("what the shared shingles are (first 20, alphabetical)")
    for s in sorted({" ".join(c) for c in shared_all})[:20]:
        print("  " + s[:120])
    print(f"  ... {len(shared_all)} shared 8-token runs in total")

    h("ERC-6551 account implementations vs the public EIP-6551 reference text")
    ref = "\n".join(re.findall(r"```solidity\n(.*?)```", urllib.request.urlopen(EIP6551, timeout=60).read().decode(), re.S))
    rs = shingles(tokens(ref))
    for name, files in (("Coattail BrokerAccount", ours), ("StonkBroker6551Account", theirs)):
        for f, s in files.items():
            if "BrokerAccount" in f or "6551Account" in f:
                o = shingles(tokens(s))
                print(f"  {f:<52} shares {len(o & rs) / len(o):6.1%} of its token runs with the EIP-6551 reference")

    h("own-source size (comment-stripped lines)")
    print(f"  coattail {sum(strip(s).count(chr(10)) for s in ours.values())}   stonkbrokers {sum(strip(s).count(chr(10)) for s in theirs.values())}")


if __name__ == "__main__":
    main()
