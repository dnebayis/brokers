"""Collection-level quality checks for 40x40 Loxleys bitmaps."""

from dataclasses import dataclass

from config import BITMAP_BYTES


MIN_FOREGROUND_PIXELS = 180
MAX_FOREGROUND_PIXELS = 800
MIN_INTERIOR_DETAIL_PIXELS = 50
REQUIRED_CLEAR_TOP_ROWS = 2
MAX_LOWER_BODY_PIXELS = 260
MAX_LOWER_CENTER_PIXELS = 190
MIN_LONG_HAIR_SIDE_PIXELS = 130


@dataclass(frozen=True)
class BitmapQuality:
    accepted: bool
    foreground_pixels: int
    interior_detail_pixels: int
    reason: str


def foreground_pixel_count(bitmap: bytes) -> int:
    return sum(bin(byte).count("1") for byte in bitmap)


def interior_detail_pixel_count(bitmap: bytes) -> int:
    bits = [((bitmap[index >> 3] >> (7 - (index & 7))) & 1) for index in range(1600)]
    detail = 0
    for y in range(3, 32):
        row = bits[y * 40:(y + 1) * 40]
        foreground_x = [x for x, value in enumerate(row) if value]
        if len(foreground_x) < 2:
            continue
        detail += sum(1 for x in range(min(foreground_x) + 1, max(foreground_x)) if not row[x])
    return detail


def inspect_bitmap(bitmap: bytes) -> BitmapQuality:
    if len(bitmap) != BITMAP_BYTES:
        return BitmapQuality(False, 0, 0, f"invalid_length:{len(bitmap)}")

    foreground = foreground_pixel_count(bitmap)
    interior_detail = interior_detail_pixel_count(bitmap)
    bits = [((bitmap[index >> 3] >> (7 - (index & 7))) & 1) for index in range(1600)]
    top_pixels = sum(bits[:40 * REQUIRED_CLEAR_TOP_ROWS])
    lower_body = sum(bits[27 * 40:])
    lower_center = sum(bits[y * 40 + x] for y in range(27, 40) for x in range(8, 32))
    lower_sides = lower_body - lower_center
    if top_pixels:
        return BitmapQuality(False, foreground, interior_detail, "top_margin_missing")
    # Long hair legitimately occupies both lower side edges. A torso instead
    # stays dense through the lower center, so only exempt the former pattern.
    long_hair_shape = lower_center <= MAX_LOWER_CENTER_PIXELS and lower_sides >= MIN_LONG_HAIR_SIDE_PIXELS
    if lower_body > MAX_LOWER_BODY_PIXELS and not long_hair_shape:
        return BitmapQuality(False, foreground, interior_detail, "body_too_large")
    if foreground < MIN_FOREGROUND_PIXELS:
        return BitmapQuality(False, foreground, interior_detail, "foreground_too_sparse")
    if foreground > MAX_FOREGROUND_PIXELS:
        return BitmapQuality(False, foreground, interior_detail, "foreground_too_dense")
    if interior_detail < MIN_INTERIOR_DETAIL_PIXELS:
        return BitmapQuality(False, foreground, interior_detail, "insufficient_internal_detail")
    return BitmapQuality(True, foreground, interior_detail, "accepted")
