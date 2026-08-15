#!/usr/bin/env python3
"""Validate the canonical collection and build source/bitmap trait QA sheets."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from config import MAX_SUPPLY, RENDER_BG, RENDER_FG
from preview import unpack
from quality import inspect_bitmap
from trait_names import EXACT_COUNTS_BY_CATEGORY, POOLS, build_prompt
from traits import build_collection_traits, validate_traits


CATEGORIES = tuple(POOLS)


def _color(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def _bitmap_image(raw: bytes, size: int) -> Image.Image:
    grid = unpack(raw)
    small = Image.new("RGB", (40, 40), _color(RENDER_BG))
    pixels = small.load()
    fg = _color(RENDER_FG)
    for y, row in enumerate(grid):
        for x, value in enumerate(row):
            if value:
                pixels[x, y] = fg
    return small.resize((size, size), Image.Resampling.NEAREST)


def _labels(traits: bytes) -> list[str]:
    return [POOLS[category][traits[index]] for index, category in enumerate(CATEGORIES)]


def validate(collection: Path) -> tuple[list[dict], dict]:
    plan = build_collection_traits()
    records: list[dict] = []
    errors: list[dict] = []
    quality = Counter()
    counts = {category: Counter() for category in CATEGORIES}
    bitmap_hashes: dict[str, list[int]] = defaultdict(list)
    source_hashes: dict[str, list[int]] = defaultdict(list)

    created: dict[int, list[dict]] = defaultdict(list)
    manifest = collection / "generation-manifest.jsonl"
    if manifest.exists():
        for line in manifest.read_text().splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("event") == "prediction_created":
                created[int(row["token_id"])].append(row)

    for token_id in range(1, MAX_SUPPLY + 1):
        paths = {
            "traits": collection / f"{token_id}.traits",
            "bitmap": collection / f"{token_id}.bin",
            "source": collection / f"{token_id}.src.png",
        }
        missing = [kind for kind, path in paths.items() if not path.exists()]
        if missing:
            errors.append({"tokenId": token_id, "error": "missing", "files": missing})
            continue

        try:
            traits = bytes.fromhex(paths["traits"].read_text().strip().removeprefix("0x"))
        except ValueError as exc:
            errors.append({"tokenId": token_id, "error": "trait_parse", "detail": str(exc)})
            continue
        if not validate_traits(traits):
            errors.append({"tokenId": token_id, "error": "invalid_traits"})
        if traits != plan[token_id - 1]:
            errors.append({"tokenId": token_id, "error": "deterministic_plan_mismatch"})

        for index, category in enumerate(CATEGORIES):
            counts[category][traits[index]] += 1

        bitmap = paths["bitmap"].read_bytes()
        result = inspect_bitmap(bitmap)
        quality[result.reason] += 1
        if not result.accepted:
            errors.append({"tokenId": token_id, "error": "bitmap_quality", "detail": result.reason})

        try:
            with Image.open(paths["source"]) as source:
                source.verify()
                source_size = list(source.size)
                source_mode = source.mode
        except Exception as exc:  # Pillow exposes several decoder-specific exceptions
            errors.append({"tokenId": token_id, "error": "source_invalid", "detail": str(exc)})
            source_size, source_mode = [], ""

        bitmap_hashes[hashlib.sha256(bitmap).hexdigest()].append(token_id)
        source_hashes[hashlib.sha256(paths["source"].read_bytes()).hexdigest()].append(token_id)
        expected_prompt = build_prompt(traits)
        prompt_matches = any(
            row.get("traits") == "0x" + traits.hex()
            and row.get("prompt", "").startswith(expected_prompt)
            for row in created[token_id]
        )
        if not prompt_matches:
            errors.append({"tokenId": token_id, "error": "generation_prompt_mismatch"})

        records.append({
            "tokenId": token_id,
            "traitsHex": "0x" + traits.hex(),
            "labels": dict(zip(CATEGORIES, _labels(traits))),
            "sourceSize": source_size,
            "sourceMode": source_mode,
            "quality": result.reason,
        })

    count_mismatches = {}
    for category in CATEGORIES:
        expected = list(EXACT_COUNTS_BY_CATEGORY[category])
        if category != "Type":
            expected[0] = MAX_SUPPLY - sum(expected[1:])
        actual = [counts[category][index] for index in range(len(POOLS[category]))]
        if actual != expected:
            count_mismatches[category] = {"actual": actual, "expected": expected}

    duplicate_bitmaps = [ids for ids in bitmap_hashes.values() if len(ids) > 1]
    duplicate_sources = [ids for ids in source_hashes.values() if len(ids) > 1]
    summary = {
        "expectedTokens": MAX_SUPPLY,
        "validatedTokens": len(records),
        "errors": errors,
        "countMismatches": count_mismatches,
        "quality": dict(quality),
        "duplicateBitmaps": duplicate_bitmaps,
        "duplicateSources": duplicate_sources,
    }
    return records, summary


def build_sheets(collection: Path, records: list[dict], output: Path, per_page: int = 64) -> None:
    output.mkdir(parents=True, exist_ok=True)
    columns = 8
    rows = math.ceil(per_page / columns)
    cell_width, cell_height = 270, 210
    preview_size = 102
    bg, fg = _color(RENDER_BG), _color(RENDER_FG)
    title_font, label_font = _font(14), _font(11)

    for page_start in range(0, len(records), per_page):
        page_records = records[page_start:page_start + per_page]
        sheet = Image.new("RGB", (columns * cell_width, rows * cell_height), bg)
        draw = ImageDraw.Draw(sheet)
        for index, record in enumerate(page_records):
            token_id = record["tokenId"]
            x = (index % columns) * cell_width
            y = (index // columns) * cell_height
            with Image.open(collection / f"{token_id}.src.png") as source:
                source = source.convert("RGB")
                source.thumbnail((preview_size, preview_size), Image.Resampling.LANCZOS)
                sx = x + (preview_size - source.width) // 2
                sy = y + 22 + (preview_size - source.height) // 2
                sheet.paste(source, (sx, sy))
            bitmap = _bitmap_image((collection / f"{token_id}.bin").read_bytes(), preview_size)
            sheet.paste(bitmap, (x + preview_size + 10, y + 22))
            draw.text((x + 4, y + 3), f"#{token_id}", font=title_font, fill=fg)

            non_none = [
                f"{category}: {value}"
                for category, value in record["labels"].items()
                if category == "Type" or value != "None"
            ]
            lines = [" · ".join(non_none[:2]), " · ".join(non_none[2:4]), " · ".join(non_none[4:])]
            for line_index, line in enumerate(line for line in lines if line):
                draw.text((x + 4, y + 132 + line_index * 19), line, font=label_font, fill=fg)
            draw.rectangle((x, y, x + cell_width - 1, y + cell_height - 1), outline=fg, width=1)

        first = page_records[0]["tokenId"]
        last = page_records[-1]["tokenId"]
        sheet.save(output / f"tokens-{first:04d}-{last:04d}.png")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--collection", type=Path, default=Path("collection"))
    parser.add_argument("--output", type=Path, default=Path("trait-audit"))
    parser.add_argument("--sheets", action="store_true")
    args = parser.parse_args()

    records, summary = validate(args.collection)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "report.json").write_text(json.dumps({"summary": summary, "tokens": records}, indent=2))
    if args.sheets:
        build_sheets(args.collection, records, args.output / "sheets")
    print(json.dumps(summary, indent=2))
    if summary["errors"] or summary["countMismatches"] or summary["duplicateBitmaps"] or summary["duplicateSources"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
