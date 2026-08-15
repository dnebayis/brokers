"""Exact collection traits and deterministic FLUX prompt construction."""

from typing import Optional

from config import CHARACTER_TYPES, PROMPT_STYLE_SUFFIX, TYPE_COUNTS


HEADWEAR = [
    "None", "Beanie", "Pilot Helmet", "Tiara", "Top Hat",
    "Cowboy Hat", "Hoodie", "Cap Forward", "Bandana",
]
EYES = ["None", "Welding Goggles", "3D Glasses", "VR", "Classic Shades"]
MOUTH = [
    "None", "Buck Teeth", "Medical Mask", "Cigarette",
    "Smile", "Pipe", "Hot Lipstick",
]
JEWELRY = ["None", "Choker", "Silver Chain", "Gold Chain", "Earring"]
FACE = ["None", "Spots", "Rosy Cheeks", "Clown Nose", "Mole"]
ACCESSORY = [
    "None", "Headphones", "Earbuds", "Hair Clip", "Small Nose Ring",
    "Headband", "Laurel Wreath", "Flower Behind Ear", "Cheek Bandage",
    "Eyepatch", "Round Glasses", "Aviator Shades", "Neck Scarf",
    "Neck Kerchief", "Pendant", "Septum Ring",
]

# Counts are exact marginal totals across MAX_SUPPLY=1776. Index 0 is filled
# automatically with the remainder for every optional category.
EXACT_COUNTS_BY_CATEGORY = {
    "Type": TYPE_COUNTS,
    "Headwear": [0, 8, 10, 10, 20, 25, 46, 45, 85],
    "Eyes": [0, 15, 51, 59, 89],
    "Mouth": [0, 14, 31, 171, 42, 56, 124],
    "Jewelry": [0, 9, 28, 30, 437],
    "Face": [0, 22, 23, 38, 114],
    # New high-visibility casual accessories. These supplement, rather than
    # alter, the user's locked rarity counts above.
    "Accessory": [0, 240, 140, 100, 100, 110, 60, 90, 100, 120, 120, 120, 100, 80, 110, 70],
}

POOLS = {
    "Type": [CHARACTER_TYPES[i] for i in range(len(CHARACTER_TYPES))],
    "Headwear": HEADWEAR,
    "Eyes": EYES,
    "Mouth": MOUTH,
    "Jewelry": JEWELRY,
    "Face": FACE,
    "Accessory": ACCESSORY,
}

ROLE_PROMPTS = {
    "alien": (
        "playful little grey alien character with a large smooth uninterrupted oval head, "
        "huge expressive almond eyes and no stray head protrusions"
    ),
    "ape": (
        "unmistakable anthropomorphic ape character, heavy brow ridge, broad protruding muzzle, "
        "wide nostrils, rounded natural ape ears and dense cheek fur"
    ),
    "zombie": (
        "unmistakable stylized undead zombie character, hollow mismatched eyes, deep cheek hollows, "
        "bold cracked-skin seams, uneven exposed teeth and an asymmetrical skull-like face, "
        "clearly not a healthy living human, playful rather than frightening, no blood and no gore"
    ),
    "female": "distinctive female human character with a natural expressive face",
    "male": "distinctive male human character with a natural expressive face",
}
RARE_TYPES = {"alien", "ape", "zombie"}

# Visual-only variation derived from byte 7. It is intentionally absent from
# public metadata and does not alter the exact rarity table supplied for v1.
HAIR_VISUALS = [
    "short textured hair", "messy layered hair", "soft wavy hair", "tight curly hair",
    "rounded afro", "clean buzzcut", "long loose hair", "chin-length bob",
    "short locs", "neat braids", "low ponytail", "small hair bun",
    "side-swept hair", "undercut", "soft mohawk", "close-cropped hair",
    "shoulder-length curls", "asymmetric bob", "shaggy fringe", "high ponytail",
    "flat-top hair", "slicked-back hair", "two small buns", "long straight hair",
]
CASUAL_STYLES = [
    "a plain crewneck T-shirt", "a casual open-collar overshirt", "a soft hoodie neckline",
    "a light denim jacket over a plain shirt", "a plain turtleneck", "a casual bomber jacket",
    "a knit crewneck sweater", "a simple workwear shirt without badges or logos",
    "a striped casual T-shirt", "a sleeveless hoodie neckline", "a light windbreaker",
    "a loose boat-neck top",
]
FACE_SHAPES = [
    "round soft face", "long narrow face", "square jaw", "heart-shaped face",
    "diamond face", "broad cheekbones", "oval face", "angular jaw",
    "full cheeks", "tapered chin", "wide jaw", "high cheekbones",
]
NOSE_SHAPES = [
    "small button nose", "broad rounded nose", "long straight nose", "short upturned nose",
    "strong aquiline nose", "flat wide nose", "narrow pointed nose", "soft curved nose",
]
EXPRESSIVE_MOODS = [
    "mischievous half-smile", "calm curious gaze", "confident grin", "warm relaxed smile",
    "playful raised eyebrow", "cool deadpan expression", "cheerful open expression",
    "subtle skeptical look", "gentle shy smile", "bold self-assured gaze",
]


def label(category: str, value: int) -> str:
    """Human-readable public metadata label."""
    pool = POOLS[category]
    return pool[value] if 0 <= value < len(pool) else pool[0]


def apply_legendary_overrides(token_id: int, traits: bytes) -> bytes:
    return traits


def legendary_prompt(token_id: int) -> Optional[str]:
    return None


def _visual_seed(traits: bytes) -> int:
    return traits[7]


def build_prompt(traits: bytes) -> str:
    """Build a natural PFP prompt from seven public traits plus visual seed."""
    typ = label("Type", traits[0])
    headwear = label("Headwear", traits[1])
    eyes = label("Eyes", traits[2])
    mouth = label("Mouth", traits[3])
    jewelry = label("Jewelry", traits[4])
    face = label("Face", traits[5])
    accessory = label("Accessory", traits[6])
    seed = _visual_seed(traits)

    parts = [
        ROLE_PROMPTS[typ],
        "natural personal profile-picture character",
        EXPRESSIVE_MOODS[(seed * 11 + 4) % len(EXPRESSIVE_MOODS)],
    ]

    if typ in {"female", "male"}:
        parts.extend([
            FACE_SHAPES[(seed * 5 + 3) % len(FACE_SHAPES)],
            NOSE_SHAPES[(seed * 7 + 1) % len(NOSE_SHAPES)],
        ])

    if typ in {"female", "male"}:
        parts.append(HAIR_VISUALS[(seed * 13 + 5) % len(HAIR_VISUALS)])
    elif typ == "zombie":
        parts.append("ragged uneven hair with a broken silhouette")
    elif typ == "ape":
        parts.append("short natural crown fur")
    else:
        parts.append("smooth hairless head")

    parts.append(f"wearing {CASUAL_STYLES[(seed * 17 + 7) % len(CASUAL_STYLES)]}")

    if headwear != "None":
        parts.append(f"wearing a bold dark {headwear.lower()} with a clean recognizable silhouette")
    if eyes != "None":
        parts.append(f"wearing bold dark {eyes.lower()} over the eyes, clearly readable at icon size")
    if mouth != "None":
        if mouth == "Smile":
            parts.append("clear warm smile")
        elif mouth == "Hot Lipstick":
            parts.append("bold lipstick")
        elif mouth in {"Cigarette", "Pipe"}:
            parts.append(f"holding a {mouth.lower()} naturally at the corner of the mouth")
        else:
            parts.append(mouth.lower())
    if jewelry != "None":
        if jewelry == "Gold Chain":
            parts.append(
                "wearing an oversized solid near-black flat curb-link necklace, with large rectangular links "
                "and white holes, occupying a clearly visible open neckline gap; this represents the gold chain trait"
            )
        elif jewelry == "Silver Chain":
            parts.append(
                "wearing a bold near-black twisted rope-link necklace with repeated white gaps, "
                "clearly visible at icon size; this represents the silver chain trait"
            )
        elif jewelry == "Earring":
            parts.append("wearing one bold dark hoop earring clearly separated from the ear")
        else:
            parts.append(f"wearing a thick dark {jewelry.lower()} clearly visible at the neckline")
    if face != "None":
        parts.append(face.lower())
    if accessory != "None":
        if accessory == "Headphones":
            parts.append("large over-ear headphones clearly visible around both ears")
        elif accessory == "Earbuds":
            parts.append(
                "large dark wireless earbuds with short stems clearly visible in both ears, "
                "each separated from the ear by a white gap"
            )
        elif accessory == "Cheek Bandage":
            parts.append("small rectangular bandage clearly visible on one cheek")
        elif accessory in {"Eyepatch", "Round Glasses", "Aviator Shades"}:
            parts.append(f"wearing prominent {accessory.lower()} clearly separated from the hair")
        elif accessory == "Flower Behind Ear":
            parts.append("single bold flower clearly visible behind one ear")
        elif accessory == "Hair Clip":
            parts.append("one oversized dark hair clip clearly visible against the head with a white border gap")
        elif accessory in {"Neck Scarf", "Neck Kerchief", "Pendant"}:
            parts.append(f"wearing a clearly visible {accessory.lower()} at the neckline")
        else:
            parts.append(f"wearing {accessory.lower()}")

    return ", ".join(parts) + ", " + PROMPT_STYLE_SUFFIX
