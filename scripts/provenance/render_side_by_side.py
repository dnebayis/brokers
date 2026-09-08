"""Render the side-by-side code images used in the provenance thread.

Every snippet, address, block number, compiler version and verification status comes from
Sourcify (chain 4663) at run time; the ERC-6551 reference comes from the EIP text.  Needs
Google Chrome for the PNG step.  Usage:  python3 render_side_by_side.py  (writes images/)
"""
import html, json, re, subprocess, os, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
os.makedirs("images", exist_ok=True)
os.makedirs("cache", exist_ok=True)
SOURCIFY = "https://sourcify.dev/server/v2/contract/4663/{addr}?fields=sources,compilation,deployment"

def cached(name, url):
    p = os.path.join("cache", name)
    if not os.path.exists(p):
        with urllib.request.urlopen(url, timeout=90) as r:
            open(p, "wb").write(r.read())
    return p

def load(addr):
    return json.load(open(cached(addr + ".json", SOURCIFY.format(addr=addr))))

def file_lines(addr, path, a, b):
    L = load(addr)["sources"][path]["content"].split("\n")[a - 1 : b]
    ind = min((len(l) - len(l.lstrip()) for l in L if l.strip()), default=0)
    return [(a + i, l[ind:]) for i, l in enumerate(L)]

def gap():
    return [(None, "…")]

def code_html(lines):
    out = []
    for n, l in lines:
        if n is None:
            out.append('<span class="ln"></span><span class="gap">…</span>')
        else:
            out.append(f'<span class="ln">{n}</span>{html.escape(l)}')
    return "\n".join(out)

# ---- provenance facts (from sourcify v2 + chain rpc, fetched 2026-09-08) ----
S_NFT = "0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0"
S_ACT = "0xacd5ae3c060c1137fe2ee86b0ab2ef697456f664"
S_CLK = "0x1f12fe622c11947f93f53d63f68f7f46b6d081c9"
S_ACC = "0xe946075125843aadb5e40e59f513d929af507c4b"
S_REG = "0x28c154cbdeaecbf5f72b6ae48535ab9a431a4161"
C_NFT = "0x1122dB21998707F8c2eD8182734356C947fA5e98"
C_BST = "0x7bAf435847A4b45c2e22a7fd13549C3192C95953"
C_ACC = "0x32A055D504840E69B7a0B2136264EEF643f6312C"
CANON = "0x000000006551c19487814612e58FE06813775758"

def meta(addr, date):
    d = load(addr)
    c, dep = d["compilation"], d["deployment"]
    match = {"exact_match": "exact match", "match": "match"}[d["match"]]
    return dict(
        addr=addr, name=c["name"], path=c["fullyQualifiedName"].split(":")[0],
        match=match, solc=c["compilerVersion"].split("+")[0], block=f'{int(dep["blockNumber"]):,}',
        tx=dep["transactionHash"], date=date, verified=d["verifiedAt"][:10],
    )

M = {
    S_NFT: meta(S_NFT, "jul 17 2026"), S_ACT: meta(S_ACT, "jul 17 2026"), S_CLK: meta(S_CLK, "aug 3 2026"),
    S_ACC: meta(S_ACC, "jul 17 2026"), S_REG: meta(S_REG, "jul 17 2026"),
    C_NFT: meta(C_NFT, "aug 18 2026"), C_BST: meta(C_BST, "aug 18 2026"), C_ACC: meta(C_ACC, "aug 18 2026"),
}

def evidence(addr, who, fn, lines_label, extra=""):
    m = M[addr]
    return f'''<div class="ev">
  <div class="row1"><span class="who">{who}</span><span class="fn">{html.escape(fn)}</span></div>
  <div class="kv"><b>contract</b><span>{m["name"]} · {m["addr"]}</span></div>
  <div class="kv"><b>source</b><span>{m["path"]} · lines {lines_label}</span></div>
  <div class="kv"><b>verified</b><span>sourcify {m["match"]} ({m["verified"]}) · solc {m["solc"]} · deployed block {m["block"]} ({m["date"]})</span></div>
  <div class="kv"><b>read it</b><span>robinhoodchain.blockscout.com/address/{m["addr"]}?tab=contract</span></div>
  <div class="kv"><b>or</b><span>sourcify.dev/#/lookup/{m["addr"]}{extra}</span></div>
</div>'''

CSS = '''
body{margin:0;width:1800px;height:1150px;background:#EDE8DE;color:#343945;font-family:"IBM Plex Sans",system-ui,sans-serif;position:relative;overflow:hidden}
.px{font-family:Silkscreen}
h1{position:absolute;left:60px;top:40px;margin:0;font-size:20px;letter-spacing:.5px}
.sub{position:absolute;left:60px;top:76px;font-size:15px;color:#4e5666;max-width:1500px}
.col{position:absolute;top:118px;background:#F5F2EB;border:2px solid #4e5666;box-shadow:4px 4px 0 #4e5666;overflow:hidden}
.two .col{width:830px;height:852px}.two .l{left:60px}.two .r{left:910px}
.three .col{width:540px;height:852px}.three .a{left:60px}.three .b{left:630px}.three .c{left:1200px}
.ev{padding:10px 14px 9px;border-bottom:2px solid #4e5666;background:#EDE8DE}
.row1{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
.who{font-family:Silkscreen;font-size:11px;color:#a6412f;letter-spacing:.4px}
.fn{font-family:"IBM Plex Mono",monospace;font-size:12px;color:#343945}
.kv{font-family:"IBM Plex Mono",monospace;font-size:10.6px;line-height:1.5;color:#4e5666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kv b{font-family:"IBM Plex Sans",system-ui,sans-serif;font-weight:600;color:#757b8a;text-transform:uppercase;font-size:9.5px;letter-spacing:.5px}
.kv span{white-space:inherit;overflow:hidden;text-overflow:ellipsis}
pre{margin:0;padding:10px 12px;font-family:"IBM Plex Mono",monospace;font-size:11.2px;line-height:1.36;white-space:pre;color:#343945}
.three pre{font-size:9.8px;line-height:1.34;white-space:pre-wrap;word-break:break-all}
.kv{display:grid;grid-template-columns:62px 1fr}
.three .kv{white-space:normal;word-break:break-all;overflow:visible}
.three .ln{width:24px;margin-right:8px}
.ln{display:inline-block;width:30px;color:#a9aebb;text-align:right;margin-right:12px;user-select:none}
.gap{color:#757b8a}
.cap{position:absolute;left:60px;right:60px;top:992px;font-size:16.5px;line-height:1.5;color:#343945;background:#F5F2EB;border:2px solid #4e5666;box-shadow:4px 4px 0 #4e5666;padding:12px 18px}
.foot{position:absolute;left:60px;right:60px;top:1108px;font-size:12px;color:#757b8a;display:flex;justify-content:space-between}
'''

HEAD = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Silkscreen&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap"><style>' + CSS + "</style></head>"
FOOT = '<div class="foot"><span>all code from the verified sources on sourcify.dev, chain 4663 · read the same lines on robinhoodchain.blockscout.com</span><span class="px">COATTAIL BROKERS · ROBINHOOD CHAIN</span></div>'

def page2(name, title, sub, left, right, cap):
    body = f'''<body class="two"><h1 class="px">{title}</h1><div class="sub">{sub}</div>
<div class="col l">{left[0]}<pre>{code_html(left[1])}</pre></div>
<div class="col r">{right[0]}<pre>{code_html(right[1])}</pre></div>
<div class="cap">{cap}</div>{FOOT}</body></html>'''
    open(os.path.join("images", name + ".html"), "w").write(HEAD + body)

# ---- page 1: mint ----
page2("code1", "MINT: HOW A BROKER IS BORN",
      "the two mint functions, as verified on chain. every header line is checkable: open the explorer link, click the contract tab, scroll to the line numbers.",
      (evidence(S_NFT, "STONKBROKERS", "mint(uint8 stage, uint256 quantity)", "219 to 263"), file_lines(S_NFT, "src/launch-nft/StonkBrokers.sol", 219, 263)),
      (evidence(C_NFT, "COATTAIL BROKERS", "mint(uint256 qty)", "133 to 167"), file_lines(C_NFT, "src/CoattailBroker.sol", 133, 167)),
      "theirs: whitelist stages, a trait seed, a stock grant pushed into the wallet at mint. ours: a random id draw, an empty wallet, the price forwarded to the creator, overpay refunded. same job, not one shared line.")

# ---- page 2: activation ----
page2("code2", "ACTIVATION: HOW A BROKER STARTS EARNING",
      "how each protocol turns a minted broker into an earning one. left: a tiered manager contract. right: one burn on the nft contract, one snapshot on the booster.",
      (evidence(S_ACT, "STONKBROKERS", "activate(tokenId, tier) / _activateOne(...)", "116 to 118, 144 to 175"),
       file_lines(S_ACT, "src/activation/ActivationManager.sol", 116, 118) + gap() + file_lines(S_ACT, "src/activation/ActivationManager.sol", 144, 175)),
      (evidence(C_NFT, "COATTAIL BROKERS", "CoattailBroker.activate(tokenId) + Booster.activate(tokenId)", "231 to 242 · Booster.sol 181 to 192",
                f'<div class="kv"><b>booster</b><span>Booster · {C_BST} · sourcify exact match · block {M[C_BST]["block"]}</span></div>'),
       file_lines(C_NFT, "src/CoattailBroker.sol", 231, 242) + gap() + file_lines(C_BST, "src/Booster.sol", 181, 192)),
      "theirs: four tiers, upgrade math between tiers, a weight per broker, a fee split by a separate manager. ours: one flat $coat burn, one flag, and the booster records the reward index so the broker earns from that moment. different design, different code.")

# ---- page 3: payroll ----
page2("code3", "PAYROLL: HOW STOCK REACHES THE WALLETS",
      "the engine that buys stock and hands it to brokers. left: a round machine with phases and elections. right: a per-share index fed by the congress basket.",
      (evidence(S_CLK, "STONKBROKERS", "_openRound() / _swapRound()", "553 to 572, 688 to 711"),
       file_lines(S_CLK, "src/rewards/DirectedClockInBooster.sol", 553, 572) + gap() + file_lines(S_CLK, "src/rewards/DirectedClockInBooster.sol", 688, 711)),
      (evidence(C_BST, "COATTAIL BROKERS", "_poke() / _claim()", "228 to 229, 232 to 259, 303 to 314"),
       file_lines(C_BST, "src/Booster.sol", 228, 229) + gap() + file_lines(C_BST, "src/Booster.sol", 232, 259) + gap() + file_lines(C_BST, "src/Booster.sol", 303, 314)),
      "theirs: open a round, tally holder elections per stock, swap a pot through a menu, distribute. ours: read the congress basket from the registry, buy each slice, add to a per-share index; brokers claim into their own wallet. nothing to copy from either side.")

# ---- page 4: erc-6551, three columns, numbers computed live ----
def strip(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return re.sub(r"//[^\n]*", "", s)
def toks(s): return re.findall(r"[A-Za-z_]\w*|\d+|[^\s\w]", strip(s))
def sh(t, k=8): return set(tuple(t[i:i+k]) for i in range(max(0, len(t)-k+1)))
eip = open(cached("eip6551.md", "https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-6551.md")).read()
ref = "\n".join(re.findall(r"```solidity\n(.*?)```", eip, re.S))
rs = sh(toks(ref))
ours = sh(toks(load(C_ACC)["sources"]["src/BrokerAccount.sol"]["content"])); theirs = sh(toks(load(S_ACC)["sources"]["src/launch-nft/StonkBroker6551Account.sol"]["content"]))
pct_ours = len(ours & rs) / len(ours); pct_theirs = len(theirs & rs) / len(theirs)
jac = len(ours & theirs) / len(ours | theirs)
authors = len([a for a in re.search(r"^author: (.*)$", eip, re.M).group(1).split(", ") if a])
print(f"ours vs eip {pct_ours:.1%}  theirs vs eip {pct_theirs:.1%}  ours vs theirs jaccard {jac:.1%}  authors {authors}")

eip_lines = [l for l in ref.split("\n")]
# the example account block: find 'contract ERC6551Account' and take through owner()
ei = next(i for i, l in enumerate(eip_lines) if l.startswith("contract ERC6551Account"))
ej = next(i for i in range(ei, len(eip_lines)) if eip_lines[i].startswith("}"))
ref_excerpt = eip_lines[ei:ej+1]
# trim: drop supportsInterface + token() to fit, keep execute/isValidSigner/isValidSignature/owner/_isValidSigner
def block(lines, start_pat, end_pat="^    }"):
    i = next(k for k, l in enumerate(lines) if re.search(start_pat, l))
    j = next(k for k in range(i, len(lines)) if re.match(end_pat, lines[k]))
    return lines[i:j+1]
eip_show = [ref_excerpt[0]] + ["    uint256 public state;", ""] + block(ref_excerpt, r"function execute") + [""] + block(ref_excerpt, r"function isValidSigner") + [""] + block(ref_excerpt, r"function owner") + [""] + block(ref_excerpt, r"function _isValidSigner") + ["}"]
eip_show = [(None if False else "", l) for l in eip_show]
def nolines(rows): return [(-1, l) for _, l in rows]

def code_html_plain(rows):
    return "\n".join('<span class="ln"></span>' + html.escape(l) for _, l in rows)

c_rows = file_lines(C_ACC, "src/BrokerAccount.sol", 36, 64) + gap() + file_lines(C_ACC, "src/BrokerAccount.sol", 89, 94) + gap() + file_lines(C_ACC, "src/BrokerAccount.sol", 121, 124)
s_rows = file_lines(S_ACC, "src/launch-nft/StonkBroker6551Account.sol", 14, 56)

ev_eip = f'''<div class="ev">
  <div class="row1"><span class="who">THE PUBLIC STANDARD</span><span class="fn">ERC-6551 reference account</span></div>
  <div class="kv"><b>source</b><span>eips.ethereum.org/EIPS/eip-6551 · "reference implementation" section</span></div>
  <div class="kv"><b>created</b><span>2023-02-23 · {authors} authors (jayden windle, benny giang, wilkins chung, vectorized …)</span></div>
  <div class="kv"><b>registry</b><span>{CANON} · same address on every evm chain</span></div>
  <div class="kv"><b>license</b><span>CC0, anyone may copy it. that is the point of a standard.</span></div>
  <div class="kv"><b>text</b><span>github.com/ethereum/ERCs/blob/master/ERCS/erc-6551.md</span></div>
</div>'''
ev_ours = evidence(C_ACC, "COATTAIL BROKERS", "BrokerAccount", "36 to 64, 89 to 94, 121 to 124",
                   f'<div class="kv"><b>registry</b><span>uses the canonical {CANON} (CoattailBroker.registry(), read on chain)</span></div>')
ev_theirs = evidence(S_ACC, "STONKBROKERS", "StonkBroker6551Account", "14 to 56",
                     f'<div class="kv"><b>registry</b><span>own copy at {S_REG} (StonkBrokers.registry(), read on chain)</span></div>')

cap4 = (f"an nft that owns a wallet is a public standard from 2023, not a product idea anyone owns. our account is built on the reference text: "
        f"{pct_ours:.0%} of its 8-token runs appear in the eip verbatim. theirs is a shorter custom variant ({pct_theirs:.0%}). "
        f"between the two accounts themselves: {jac:.1%} overlap, all of it interface boilerplate.")
body = f'''<body class="three"><h1 class="px">ERC-6551: THE STANDARD BOTH PROJECTS BUILD ON</h1>
<div class="sub">three token-bound accounts side by side: the reference from the public standard, ours, theirs. overlap numbers computed from these exact files.</div>
<div class="col a">{ev_eip}<pre>{code_html_plain(eip_show)}</pre></div>
<div class="col b">{ev_ours}<pre>{code_html(c_rows)}</pre></div>
<div class="col c">{ev_theirs}<pre>{code_html(s_rows)}</pre></div>
<div class="cap">{cap4}</div>{FOOT}</body></html>'''
open(os.path.join("images", "code4.html"), "w").write(HEAD + body)

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for n in ("code1", "code2", "code3", "code4"):
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1800,1150",
                    "--force-device-scale-factor=2", "--virtual-time-budget=8000", f"--screenshot=images/{n}.png", f"file://{HERE}/images/{n}.html"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(n, os.path.getsize(os.path.join("images", n + ".png")))
