#!/usr/bin/env python3
"""
Preview generated Loxleys bitmaps the way they will render on-chain:
black canvas, flat phosphor-green art (no depth).

Usage:
    python preview.py --dir ./output/ --out preview.png
    python preview.py --dir ./output/ --out preview.png --cols 6 --scale 10
"""
import argparse
import glob
import os
from pathlib import Path

from config import GRID_WIDTH as W, GRID_HEIGHT as H, BITMAP_BYTES, RENDER_BG, RENDER_FG


def _hex(c):
    c = c.lstrip("#")
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def unpack(bitmap: bytes):
    """200-byte bitmap -> 40x40 list of 0/1 (MSB-first, row-major)."""
    g = [[0] * W for _ in range(H)]
    for i in range(W * H):
        if (bitmap[i >> 3] >> (7 - (i & 7))) & 1:
            g[i // W][i % W] = 1
    return g


def render_cell(draw, g, ox, oy, scale):
    bg, fg = _hex(RENDER_BG), _hex(RENDER_FG)
    draw.rectangle([ox, oy, ox + W * scale - 1, oy + H * scale - 1], fill=bg)
    # flat green fill — no depth
    for y in range(H):
        for x in range(W):
            if g[y][x]:
                draw.rectangle([ox + x * scale, oy + y * scale,
                                ox + x * scale + scale - 1, oy + y * scale + scale - 1], fill=fg)


def main():
    from PIL import Image, ImageDraw
    ap = argparse.ArgumentParser(description="Preview Loxleys .bin bitmaps (white/green/depth)")
    ap.add_argument("--dir", required=True, help="Directory of .bin files")
    ap.add_argument("--out", default="preview.png", help="Output PNG path")
    ap.add_argument("--cols", type=int, default=5)
    ap.add_argument("--scale", type=int, default=11)
    ap.add_argument("--pad", type=int, default=0)
    ap.add_argument("--expected-count", type=int, default=0,
                    help="Require token IDs 1..N in order; fail if any are unavailable")
    ap.add_argument("--token-ids-file",
                    help="Render only the newline-separated token IDs in this file")
    ap.add_argument("--review-fallback", action="store_true",
                    help="Use {id}.review.bin when a production bitmap awaits manual rare-Type approval")
    ap.add_argument("--labels", action="store_true", help="Print token ID below every bitmap")
    args = ap.parse_args()

    # Only production `{tokenId}.bin` files belong in a collection preview.
    # Review/crop artifacts may live beside them and must never be presented as
    # additional tokens.
    if args.token_ids_file:
        token_ids = [int(line.strip()) for line in Path(args.token_ids_file).read_text().splitlines()
                     if line.strip()]
        files = []
        missing = []
        for token_id in token_ids:
            final = Path(args.dir, f"{token_id}.bin")
            review = Path(args.dir, f"{token_id}.review.bin")
            if args.review_fallback and review.exists():
                files.append(str(review))
            elif final.exists():
                files.append(str(final))
            else:
                missing.append(token_id)
        if missing:
            raise SystemExit(f"Missing token bitmaps: {missing}")
    elif args.expected_count:
        files = []
        missing = []
        for token_id in range(1, args.expected_count + 1):
            final = Path(args.dir, f"{token_id}.bin")
            review = Path(args.dir, f"{token_id}.review.bin")
            if final.exists():
                files.append(str(final))
            elif args.review_fallback and review.exists():
                files.append(str(review))
            else:
                missing.append(token_id)
        if missing:
            raise SystemExit(f"Missing token bitmaps: {missing}")
    else:
        files = [
            path for path in glob.glob(os.path.join(args.dir, "*.bin"))
            if os.path.splitext(os.path.basename(path))[0].isdigit()
        ]
        files.sort(key=lambda p: int(os.path.splitext(os.path.basename(p))[0]))
    if not files:
        print(f"No .bin files in {args.dir}")
        return

    scale, pad, cols = args.scale, args.pad, args.cols
    label_height = 14 if args.labels else 0
    cell_width = W * scale + pad * 2
    cell_height = cell_width + label_height
    rows = (len(files) + cols - 1) // cols
    img = Image.new("RGB", (cols * cell_width, rows * cell_height), _hex(RENDER_BG))
    d = ImageDraw.Draw(img)
    for i, f in enumerate(files):
        with open(f, "rb") as fh:
            bitmap = fh.read()
        if len(bitmap) != BITMAP_BYTES:
            print(f"skip {f}: {len(bitmap)} bytes")
            continue
        ox = (i % cols) * cell_width + pad
        oy = (i // cols) * cell_height + pad
        render_cell(d, unpack(bitmap), ox, oy, scale)
        if args.labels:
            token_id = Path(f).name.split(".", 1)[0]
            d.text((ox + 2, oy + W * scale + 1), f"#{token_id}", fill=_hex(RENDER_FG))
    img.save(args.out)
    print(f"wrote {args.out} ({len(files)} tokens)")


if __name__ == "__main__":
    main()
