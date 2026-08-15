"""Output: save 200-byte binary bitmap + bytes8 traits as hex files."""

import os
from pathlib import Path

from config import BITMAP_BYTES
from traits import traits_to_hex, validate_traits


def save_token(
    output_dir: str,
    token_id: int,
    bitmap: bytes,
    traits: bytes,
) -> tuple[str, str]:
    """
    Save a token's bitmap and traits to disk.
    
    Creates:
      - {output_dir}/{tokenId}.bin  — 200-byte raw binary bitmap
      - {output_dir}/{tokenId}.traits — 8-byte trait hex string
      
    Args:
        output_dir: Directory to save files in.
        token_id: Token ID number.
        bitmap: 200-byte binary bitmap.
        traits: 8-byte trait combination.
        
    Returns:
        Tuple of (bitmap_path, traits_path).
        
    Raises:
        ValueError: If bitmap or traits are invalid.
    """
    if len(bitmap) != BITMAP_BYTES:
        raise ValueError(
            f"Bitmap must be exactly {BITMAP_BYTES} bytes, got {len(bitmap)}"
        )
    if not validate_traits(traits):
        raise ValueError(f"Invalid traits: {traits.hex()}")

    os.makedirs(output_dir, exist_ok=True)

    bitmap_path = os.path.join(output_dir, f"{token_id}.bin")
    traits_path = os.path.join(output_dir, f"{token_id}.traits")

    with open(bitmap_path, "wb") as f:
        f.write(bitmap)

    with open(traits_path, "w") as f:
        f.write(traits_to_hex(traits))

    return bitmap_path, traits_path


def load_existing_traits(output_dir: str) -> set[bytes]:
    """
    Load all existing trait combinations from an output directory.
    
    Scans for *.traits files and loads their hex contents.
    
    Args:
        output_dir: Directory to scan.
        
    Returns:
        Set of 8-byte trait combinations.
    """
    existing = set()
    output_path = Path(output_dir)

    if not output_path.exists():
        return existing

    for traits_file in output_path.glob("*.traits"):
        try:
            hex_str = traits_file.read_text().strip()
            if hex_str.startswith("0x"):
                hex_str = hex_str[2:]
            trait_bytes = bytes.fromhex(hex_str)
            if len(trait_bytes) == 8:
                existing.add(trait_bytes)
        except (ValueError, IOError):
            continue

    return existing
