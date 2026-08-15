"""Image processing: resize to 40×40, convert to monochrome bitmap."""

from PIL import Image, ImageFilter
import numpy as np
from io import BytesIO

from config import GRID_WIDTH, GRID_HEIGHT, BITMAP_BYTES, THRESHOLD


def load_image(source) -> Image.Image:
    """Load an image from bytes, file path, or file-like object."""
    if isinstance(source, bytes):
        img = Image.open(BytesIO(source))
    elif isinstance(source, str):
        img = Image.open(source)
    else:
        img = Image.open(source)
    if "A" in img.getbands():
        rgba = img.convert("RGBA")
        white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        img = Image.alpha_composite(white, rgba).convert("RGB")
    return img


def resize_to_grid(img: Image.Image) -> Image.Image:
    """Reduce a smooth source while preserving deliberate dark contour lines.

    A direct 1024→40 LANCZOS resize averages thin eyes, eyewear and mouth lines
    into the white background. The intermediate reduction plus a mild minimum
    filter retains those dark contours without asking the image model for pixels.
    """
    intermediate = img.resize((160, 160), Image.Resampling.LANCZOS)
    edge_preserved = intermediate.filter(ImageFilter.MinFilter(3))
    return edge_preserved.resize((GRID_WIDTH, GRID_HEIGHT), Image.Resampling.LANCZOS)


def to_grayscale(img: Image.Image) -> Image.Image:
    """Convert image to grayscale (L mode)."""
    return img.convert("L")


def crop_to_pfp(img: Image.Image, ratio: float = 0.82) -> Image.Image:
    """Crop a square from the upper center without rescaling facial geometry.

    This is an adaptive fallback for otherwise-good sources whose clothing fills
    too much of the lower 40x40 frame. It removes outer shoulders and torso while
    retaining the complete top of the source image.
    """
    if not 0.5 <= ratio <= 1.0:
        raise ValueError("PFP crop ratio must be between 0.5 and 1.0")
    side = round(min(img.size) * ratio)
    left = max(0, (img.width - side) // 2)
    return img.crop((left, 0, left + side, side))


def threshold_binarize(gray: Image.Image, threshold: int = THRESHOLD) -> np.ndarray:
    """
    Apply threshold binarization.
    
    Pixels with value > THRESHOLD → 0 (background/off-white)
    Pixels with value <= THRESHOLD → 1 (foreground/off-black)
    
    Returns a 40×40 numpy array of 0s and 1s.
    """
    arr = np.array(gray, dtype=np.uint8)
    # Below or equal threshold = foreground (1), above = background (0)
    binary = (arr <= threshold).astype(np.uint8)
    return binary


def scatter_binarize(gray: Image.Image, seed: int = 0) -> np.ndarray:
    """Convert tonal shape islands into deterministic scattered pixel clusters."""
    arr = np.asarray(gray, dtype=np.float32)
    darkness = 1.0 - (arr / 255.0)
    probability = np.power(np.clip(darkness, 0.0, 1.0), 0.68) * 0.82
    yy, xx = np.indices((GRID_HEIGHT, GRID_WIDTH))
    noise = ((xx * 73 + yy * 151 + xx * yy * 17 + seed * 29 + (xx * xx + yy * yy) * 7) % 251) / 251.0
    return (noise < probability).astype(np.uint8)


def break_thin_runs(binary: np.ndarray, seed: int = 0, keep: float = 0.70) -> np.ndarray:
    """Break single-pixel contours while preserving dense feature islands."""
    padded = np.pad(binary, 1)
    neighbors = np.zeros_like(binary, dtype=np.uint8)
    for dy in range(3):
        for dx in range(3):
            if (dx, dy) != (1, 1):
                neighbors += padded[dy:dy + GRID_HEIGHT, dx:dx + GRID_WIDTH]
    yy, xx = np.indices((GRID_HEIGHT, GRID_WIDTH))
    noise = ((xx * 73 + yy * 151 + xx * yy * 17 + seed * 29) % 101) / 101.0
    return (binary & ((neighbors >= 5) | (noise < keep))).astype(np.uint8)


def pack_bitmap(binary: np.ndarray) -> bytes:
    """
    Pack a 40×40 binary array into 200 bytes.
    
    Format: MSB-first, row-major order.
    Each byte packs 8 consecutive pixels, with the first pixel
    in the most significant bit position.
    """
    # Flatten row-major
    flat = binary.flatten()
    assert len(flat) == GRID_WIDTH * GRID_HEIGHT, (
        f"Expected {GRID_WIDTH * GRID_HEIGHT} pixels, got {len(flat)}"
    )

    bitmap = bytearray(BITMAP_BYTES)
    for i, pixel in enumerate(flat):
        byte_index = i >> 3  # i // 8
        bit_pos = 7 - (i & 7)  # MSB-first
        if pixel:
            bitmap[byte_index] |= (1 << bit_pos)

    return bytes(bitmap)


def place_with_top_margin(binary: np.ndarray, clear_rows: int = 2) -> np.ndarray:
    """Translate artwork downward to reserve headroom without scaling or distortion.

    Only the bottom overflow is cropped, which intentionally removes excess torso.
    Facial geometry and every surviving pixel remain byte-for-byte unchanged.
    """
    occupied = np.flatnonzero(binary.any(axis=1))
    if not len(occupied) or occupied[0] >= clear_rows:
        return binary
    shift = clear_rows - int(occupied[0])
    placed = np.zeros_like(binary)
    placed[shift:] = binary[:-shift]
    return placed


def binarize_image(
    source,
    threshold: int = THRESHOLD,
    seed: int = 0,
    pixel_style: str = "contour",
    pfp_crop: bool = False,
    pfp_crop_ratio: float = 0.82,
) -> bytes:
    """
    Full pipeline: load image → resize → grayscale → threshold → pack.
    
    Args:
        source: Image bytes, file path, or file-like object.
        
    Returns:
        200-byte binary bitmap.
    """
    img = load_image(source)
    if pfp_crop:
        img = crop_to_pfp(img, pfp_crop_ratio)
    gray = to_grayscale(img)
    if pixel_style == "scatter":
        gray = gray.resize((GRID_WIDTH, GRID_HEIGHT), Image.Resampling.LANCZOS)
        binary = scatter_binarize(gray, seed)
        binary = break_thin_runs(binary, seed)
    elif pixel_style == "contour":
        gray = resize_to_grid(gray)
        binary = threshold_binarize(gray, threshold)
    else:
        raise ValueError(f"Unknown pixel style: {pixel_style}")
    binary = place_with_top_margin(binary)
    bitmap = pack_bitmap(binary)

    assert len(bitmap) == BITMAP_BYTES, (
        f"Bitmap must be exactly {BITMAP_BYTES} bytes, got {len(bitmap)}"
    )
    return bitmap
