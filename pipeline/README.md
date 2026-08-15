# pipeline/ — Coattail Brokers art production

This directory contains the deterministic off-chain production pipeline for the
1,776-piece collection. FLUX creates a smooth portrait source; the local pipeline
converts it to the final 40×40, 1-bit bitmap stored by `BrokerRenderer`.

## Current collection state

- Token IDs **1–1776** each have a final `.src.png`, `.bin` and `.traits` file in
  `collection/`.
- All **22 rare Types** (2 Alien, 4 Ape, 16 Zombie) were manually reviewed and
  promoted into the canonical files.
- `collection-1776-contact-sheet.png` is the complete numbered sheet;
  `rare-review-22.png` records the approved rare set.
- Local completion is not an on-chain reveal. The complete 2026-08-14 audit confirmed
  collection-wide Type, silhouette and dominant-accessory consistency. It also recorded
  expected 40×40 simplification of secondary traits and 217 same-region combinations.
  These are accepted pixel-art limitations, not upload blockers. See `TRAIT_AUDIT.md`.

Generated API attempts and temporary review files were removed after approval. Accepted source
PNGs remain in the offline review archive but are excluded from Git; canonical `.bin`, `.traits`,
`collection-manifest.json` and the audit report are versioned.

## Setup

```bash
cd pipeline
python3 -m pip install -r requirements.txt
```

Put `REPLICATE_API_TOKEN` in `pipeline/.env` or export it in the shell. Never
commit `.env`.

## Production commands

```bash
# Resumable generation: completed, quality-passing IDs are skipped.
python3 generate_batch_api.py \
  --count 1776 --output ./collection --model klein --workers 12

# Validate deterministic allocation and pipeline behavior.
python3 -m unittest discover -s . -p 'test_*.py' -v

# Rebuild the complete numbered contact sheet.
python3 preview.py --dir ./collection \
  --out collection-1776-contact-sheet.png --cols 24 --scale 4 \
  --expected-count 1776 --labels
```

Do not use `--accept-rare-type` for new outputs without visual approval. It exists
only to promote the exact `*.review.*` artifact that was inspected.

## Files and stages

| File | Responsibility |
|---|---|
| `traits.py` | Builds the deterministic 1,776-token allocation with exact marginal counts and hidden visual seeds. |
| `trait_names.py` | Maps trait bytes to metadata labels and natural PFP prompts. |
| `generate_batch_api.py` | Creates, polls and downloads FLUX predictions; resumes safely from the manifest. |
| `binarize.py` | Converts the smooth source into irregular 1-bit pixel islands; source images are never requested as pixel art. |
| `quality.py` | Rejects excessive density, sparse line art, missing internal detail, roof collisions and torso-heavy framing. |
| `output.py` | Writes the accepted 200-byte bitmap, 8-byte traits and source PNG. |
| `preview.py` | Renders numbered contact sheets in the exact on-chain palette. |

The production model alias is `klein` (`black-forest-labs/flux-2-klein-4b`).
Other aliases in `config.py` are comparison tools, not part of the canonical set.

## Output format

For each token ID:

- `{id}.src.png` — accepted high-resolution source retained offline for visual QA, not committed.
- `{id}.bin` — 200 bytes: 40×40 pixels packed most-significant-bit first.
- `{id}.traits` — an 8-byte `bytes8` value encoded as hex.

```text
flatIndex = y*40 + x
byteIndex = flatIndex >> 3
bitPos = 7 - (flatIndex & 7)
pixelOn = (bitmap[byteIndex] >> bitPos) & 1
```

Bit `1` renders slate `#4E5666`; bit `0` renders cream `#EDE8DE`.

## Trait schema

| Byte | Category | Published options |
|---|---|---|
| 0 | Type | Alien / Ape / Zombie / Female / Male |
| 1 | Headwear | Beanie, Pilot Helmet, Tiara, Top Hat, Cowboy Hat, Hoodie, Cap Forward, Bandana |
| 2 | Eyes | Welding Goggles, 3D Glasses, VR, Classic Shades |
| 3 | Mouth | Buck Teeth, Medical Mask, Cigarette, Smile, Pipe, Hot Lipstick |
| 4 | Jewelry | Choker, Silver Chain, Gold Chain, Earring |
| 5 | Face | Spots, Rosy Cheeks, Clown Nose, Mole |
| 6 | Accessory | Headphones, Earbuds, Hair Clip, Small Nose Ring, Headband, Laurel Wreath, Flower Behind Ear, Cheek Bandage, Eyepatch, Round Glasses, Aviator Shades, Neck Scarf, Neck Kerchief, Pendant, Septum Ring |
| 7 | VisualSeed | Hidden deterministic variation; not marketplace metadata |

Exact Type counts are **2 / 4 / 16 / 681 / 1,073**. Optional categories are
allocated independently and every token receives at least one non-`None` optional
metadata trait. This guarantees metadata allocation, not semantic rendering:
release QA must still compare `.traits`, `.src.png` and `.bin`, especially for
eyewear, masks, pipes, chains, headwear and rare Types.

Run `python3 audit_collection.py --sheets` for the complete machine validation and
source/bitmap comparison pack. Collection approval uses the documented standard:
recognizable Type, coherent silhouette and readable dominant traits—not literal survival
of every small source detail.

Characters are fictional PFP archetypes. Prompts intentionally avoid real people,
professional uniforms, mandatory suits, antennas and horns.
