#!/usr/bin/env python3
"""The Desk — curated trait assignment for ALL 2,000 ids (waves included).

Solves the Brokers rarity-churn problem structurally, before anything mints:

1. FIXED traits are assigned here, off-chain, with EXACT counts per option (no hash luck),
   zero exact-duplicate scenes by construction, and a deterministic seed. The full table is
   uploaded on-chain before wave 1 and its digest published, so later waves can be verified
   unriggable: Desk #1777's traits are already committed while only 500 exist.
2. LIVE data (holdings, value, age) will NEVER appear in these traits. The renderer emits it
   only as `display_type: number` + rounded fields, which rarity engines exclude. Rarity can
   therefore never move after mint — the exact failure we shipped in Brokers cannot recur.

Output: traits-2000.json (id -> trait indices) + sha256 digest + distribution report.
"""
import hashlib
import json
import random
import sys

SEED = "THE.DESK.TRAITS.V1"
TOTAL = 2000
WAVE1 = 500

# axis: (name, [(option, exact_count), ...]) — counts sum to 2000
AXES = [
    ("wall", [
        ("navy", 260), ("teal", 250), ("sage", 240), ("cream", 240), ("lavender", 230),
        ("grey", 230), ("sand", 220), ("burgundy", 180), ("midnight", 150),
    ]),
    ("wood", [
        ("oak", 560), ("walnut", 520), ("birch", 380), ("mahogany", 340), ("dark", 200),
    ]),
    ("screens", [
        ("single-large", 900), ("dual", 700), ("single-small", 400),
    ]),
    ("chart", [
        ("green-up", 1800), ("red-down", 200),
    ]),
    ("gadget", [
        ("calculator", 800), ("none", 600), ("papers", 500), ("gold-calculator", 100),
    ]),
    ("companion", [
        ("coffee", 700), ("plant", 500), ("lamp", 400), ("none", 240), ("cat", 160),
    ]),
    # accent: the color story of the small items (mug glaze, plant pot, pen, drawer trim).
    # Widens the scene space to 32,400 so 2,000 unique desks fit comfortably, and gives the
    # bigger collection the visual variety a 2,000-supply needs.
    ("accent", [
        ("crimson", 340), ("forest", 340), ("azure", 330), ("amber", 330),
        ("violet", 330), ("mono", 330),
    ]),
]


def build():
    rng = random.Random(SEED)
    cols = []
    for name, options in AXES:
        pool = []
        for idx, (_opt, count) in enumerate(options):
            pool += [idx] * count
        assert len(pool) == TOTAL, name
        rng.shuffle(pool)
        cols.append(pool)

    rows = [tuple(cols[a][i] for a in range(len(AXES))) for i in range(TOTAL)]

    # kill exact duplicates by swapping one axis value between the duplicate row and a
    # random partner row (keeps every axis count EXACT — swaps never change totals)
    def dedupe():
        for _pass in range(200):
            seen, dups = {}, []
            for i, r in enumerate(rows):
                if r in seen:
                    dups.append(i)
                else:
                    seen[r] = i
            if not dups:
                return True
            for i in dups:
                for _try in range(2000):
                    j = rng.randrange(TOTAL)
                    a = rng.randrange(len(AXES))
                    if j == i or rows[j][a] == rows[i][a]:
                        continue
                    ri, rj = list(rows[i]), list(rows[j])
                    ri[a], rj[a] = rj[a], ri[a]
                    ti, tj = tuple(ri), tuple(rj)
                    if ti not in seen and tj not in seen and ti != tj:
                        seen.pop(rows[j], None)
                        rows[i], rows[j] = ti, tj
                        seen[ti] = i
                        seen[tj] = j
                        break
        return False

    assert dedupe(), "could not reach zero duplicates"
    assert len(set(rows)) == TOTAL, "duplicate scenes remain"
    # counts still exact after swaps
    for a, (name, options) in enumerate(AXES):
        for idx, (_opt, count) in enumerate(options):
            assert sum(1 for r in rows if r[a] == idx) == count, (name, _opt)
    return rows


def report(rows):
    out = {"seed": SEED, "total": TOTAL, "axes": [
        {"name": n, "options": [o for o, _ in opts]} for n, opts in AXES
    ], "assignments": {str(i + 1): list(rows[i]) for i in range(TOTAL)}}
    blob = json.dumps(out, sort_keys=True, separators=(",", ":")).encode()
    digest = hashlib.sha256(blob).hexdigest()
    out["sha256"] = digest
    with open("traits-2000.json", "w") as f:
        json.dump(out, f, sort_keys=True, separators=(",", ":"))
    print(f"zero exact duplicates across {TOTAL} ids: OK")
    print(f"digest (over assignments): {digest}\n")
    print(f"{'axis/option':28s} {'all-2000':>9s} {'wave1-500':>10s}  (wave1 should track ~25%)")
    for a, (name, options) in enumerate(AXES):
        for idx, (opt, count) in enumerate(options):
            w1 = sum(1 for i in range(WAVE1) if rows[i][a] == idx)
            print(f"{name+'/'+opt:28s} {count:9d} {w1:10d}")
    return digest


if __name__ == "__main__":
    rows = build()
    report(rows)
