#!/usr/bin/env python3
"""Pack traits-2000.json for on-chain upload + emit renderer parity fixtures.

Packing: 4 bytes per id, 8 ids per 32-byte word, 250 words total.
  byte0 = wall<<4 | wood
  byte1 = screens<<4 | chart
  byte2 = gadget<<4 | companion
  byte3 = accent<<4 | 0
The keccak256 of the 8000-byte blob is the freeze commitment DeskRenderer's
constructor pins; publishing it alongside the existing sha256 of the JSON ties
the on-chain bytes to the curated table.

Outputs (relative to desk/art/):
  traits-packed.hex          0x-prefixed blob for the upload script / tests
  ../test/fixtures/desk-<id>.svg   exact expected SVG per fixture id
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scene_gen import load_table, compose  # noqa: E402

try:
    from eth_hash.auto import keccak
except ImportError:  # keccak only needed for the printed commit; forge recomputes anyway
    keccak = None

FIXTURE_IDS = [1, 16, 17, 22, 24, 120]

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    table = load_table(os.path.join(here, "traits-2000.json"))
    asg = table["assignments"]
    blob = bytearray()
    for i in range(1, 2001):
        t = asg[str(i)]
        assert len(t) == 7 and all(0 <= v < 16 for v in t), i
        blob += bytes([
            (t[0] << 4) | t[1],
            (t[2] << 4) | t[3],
            (t[4] << 4) | t[5],
            (t[6] << 4),
        ])
    assert len(blob) == 8000
    with open(os.path.join(here, "traits-packed.hex"), "w") as f:
        f.write("0x" + blob.hex())
    if keccak:
        print("keccak256 commit:", "0x" + keccak(bytes(blob)).hex())
    fixdir = os.path.join(here, "..", "test", "fixtures")
    os.makedirs(fixdir, exist_ok=True)
    for i in FIXTURE_IDS:
        svg = compose(asg[str(i)]).svg()
        with open(os.path.join(fixdir, f"desk-{i}.svg"), "w") as f:
            f.write(svg)
        print(f"fixture desk-{i}.svg: {len(svg)} bytes")

if __name__ == "__main__":
    main()
