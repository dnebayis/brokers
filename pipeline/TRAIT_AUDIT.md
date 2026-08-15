# Collection trait audit — 2026-08-14

## Decision

**GO at the collection's accepted 40×40 pixel-art standard.** The canonical files and
metadata allocation are internally correct; Type, overall silhouette and dominant
accessories are collection-wide consistent. Secondary details are allowed to simplify,
merge or disappear during 1-bit conversion. Literal pixel-level proof of every metadata
trait is not a release requirement.

## Complete automated verification

`python3 audit_collection.py --sheets` checked token IDs 1–1776 and produced
`trait-audit/report.json` plus 28 source/bitmap comparison sheets.

- 1,776/1,776 `.src.png`, `.bin` and `.traits` sets exist.
- Every trait byte matches the deterministic collection plan.
- Every locked marginal count is exact.
- Every source is a valid 1024×1024 RGB PNG.
- All 1,776 bitmaps pass the geometry/density quality gate.
- No duplicate source image or duplicate bitmap exists.
- Every generation prompt contains the assigned traits.

## Visual findings

The 28 sheets compare the accepted 1024×1024 source, final 40×40 bitmap and expected
metadata for every token. The review found these collection-wide patterns:

- **Type:** Alien, Ape and Zombie identities are visually recognizable. The 22 rare
  Types remain acceptable.
- **Headwear:** large silhouettes such as Top Hat, Cowboy Hat, Cap Forward, Hoodie and
  Bandana usually survive. Hair Clip, Headband, Laurel Wreath and Flower Behind Ear are
  often absent or indistinguishable from hair.
- **Eyes:** VR and broad glasses usually survive, but 3D Glasses, Classic Shades,
  Aviator Shades and Welding Goggles frequently collapse into the same dark eye band.
- **Mouth:** Medical Mask, Cigarette and Pipe are usually readable. Smile, Hot Lipstick
  and Buck Teeth are not consistently distinguishable at 40×40.
- **Jewelry:** Earring, Choker, Silver Chain and Gold Chain are often lost or become an
  ordinary neckline. Gold/Silver cannot be distinguished by color in a 1-bit palette.
- **Face:** Mole, Spots and Rosy Cheeks usually disappear during binarization. Clown Nose
  survives more often but is not guaranteed.
- **Accessory:** Headphones, Eyepatch and large eyewear are the strongest. Earbuds,
  nose rings, Septum Ring, Cheek Bandage, Pendant and most small hair/neck accessories
  are frequently missing or ambiguous.

Representative mismatches include #1 (Laurel Wreath), #9 (Septum Ring), #47 (Flower
Behind Ear), #64 (two different eyewear traits assigned to one face), #93 (Silver Chain
plus Neck Scarf) and #1030 (Gold Chain plus Laurel Wreath). The sheets are the evidence;
these IDs are examples, not an exhaustive failure list.

## Structural collision audit

Independent category shuffling creates mutually competing traits on **217 unique
tokens**:

| Collision | Assignments |
|---|---:|
| Eyes trait + accessory eyewear/eyepatch | 33 |
| Headwear + hair/head accessory | 56 |
| Necklace jewelry + scarf/kerchief/pendant | 19 |
| Earring + headphones/earbuds/flower | 114 |

Five tokens contain two collision classes. Optional-trait load is also high: 282 tokens
have three optional traits, 69 have four, six have five and one has six. A single 40×40
monochrome portrait cannot reliably prove all of these traits.

## Accepted limitations

- Secondary metadata may be represented in the source but lost in the 1-bit bitmap.
- Same-region combinations can visually merge into one dominant accessory.
- Gold/Silver describe metadata rarity; the monochrome renderer cannot encode color.
- Small face details are intentionally lower-confidence than Type, headwear and major eyewear.

These findings are retained for transparency and possible future refinement, but are not
an upload blocker under the approved stylized pixel-art standard.
