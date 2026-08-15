"""Exact deterministic trait allocation for the 1,776-token collection."""

import random
from functools import lru_cache
from typing import Set

from config import MAX_SUPPLY, TRAIT_CATEGORIES
from trait_names import EXACT_COUNTS_BY_CATEGORY, POOLS


def _exact_values(category: str, seed: int) -> list[int]:
    counts = list(EXACT_COUNTS_BY_CATEGORY[category])
    if len(counts) != len(POOLS[category]):
        raise ValueError(f"{category} count/pool length mismatch")
    if category == "Type":
        if sum(counts) != MAX_SUPPLY:
            raise ValueError("Type counts must sum to MAX_SUPPLY")
    else:
        specified = sum(counts[1:])
        if specified > MAX_SUPPLY:
            raise ValueError(f"{category} counts exceed MAX_SUPPLY")
        counts[0] = MAX_SUPPLY - specified

    values = [value for value, count in enumerate(counts) for _ in range(count)]
    random.Random(seed).shuffle(values)
    return values


@lru_cache(maxsize=16)
def build_collection_traits(seed_salt: int = 0) -> tuple[bytes, ...]:
    """Return all bytes8 values with exact marginal counts and stable assignment."""
    categories = ("Type", "Headwear", "Eyes", "Mouth", "Jewelry", "Face", "Accessory")
    columns = {
        category: _exact_values(category, 1776_001 + seed_salt * 101 + index * 31337)
        for index, category in enumerate(categories)
    }
    optional = categories[1:]
    # Preserve every marginal count while eliminating completely plain tokens.
    # Move one non-zero value from a token carrying multiple optional traits to
    # each uncovered token. This is a swap inside one column, not a resample.
    for empty_index in range(MAX_SUPPLY):
        if any(columns[category][empty_index] for category in optional):
            continue
        moved = False
        for donor_index in range(MAX_SUPPLY):
            donor_count = sum(bool(columns[category][donor_index]) for category in optional)
            if donor_count < 2:
                continue
            for category in optional:
                if columns[category][donor_index] and not columns[category][empty_index]:
                    columns[category][empty_index], columns[category][donor_index] = (
                        columns[category][donor_index],
                        columns[category][empty_index],
                    )
                    moved = True
                    break
            if moved:
                break
        if not moved:
            raise ValueError("Not enough optional traits to cover every token")
    collection = []
    used_seeds: dict[bytes, set[int]] = {}
    for index in range(MAX_SUPPLY):
        token_id = index + 1
        public = bytes(columns[category][index] for category in categories)
        seeds = used_seeds.setdefault(public, set())
        if len(seeds) == 256:
            raise ValueError("A public trait combination occurs more than 256 times")
        candidate = (token_id * 73 + sum((i + 1) * value for i, value in enumerate(public)) * 29) & 0xFF
        while candidate in seeds:
            candidate = (candidate + 1) & 0xFF
        seeds.add(candidate)
        visual_seed = bytes([candidate])
        collection.append(public + visual_seed)
    return tuple(collection)


def traits_for_token_id(token_id: int, seed_salt: int = 0) -> bytes:
    if not 1 <= token_id <= MAX_SUPPLY:
        raise ValueError(f"token_id must be in 1..{MAX_SUPPLY}")
    return build_collection_traits(seed_salt)[token_id - 1]


def generate_traits(seed: int, existing_traits: Set[bytes]) -> bytes:
    """Compatibility helper: choose the first unused exact-plan entry."""
    collection = build_collection_traits(0)
    start = seed % MAX_SUPPLY
    for offset in range(MAX_SUPPLY):
        candidate = collection[(start + offset) % MAX_SUPPLY]
        if candidate not in existing_traits:
            return candidate
    raise RuntimeError("All collection trait assignments are already used")


def validate_traits(traits: bytes) -> bool:
    if len(traits) != 8:
        return False
    return all(traits[i] <= max_value for i, (_, max_value) in enumerate(TRAIT_CATEGORIES))


def traits_to_hex(traits: bytes) -> str:
    return "0x" + traits.hex()


def hex_to_traits(hex_str: str) -> bytes:
    if hex_str.startswith("0x"):
        hex_str = hex_str[2:]
    return bytes.fromhex(hex_str)
