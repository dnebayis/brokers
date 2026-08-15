"""Configuration for the Coattail Brokers art generation pipeline.

Ported from the proven Loxleys pipeline (the one that did ~2k images for ~$2):
deterministic trait-driven prompts (NO Gemini), Flux 2 Klein via Replicate's
prediction API, binarize to a 40x40 1-bit bitmap, and a density/interior-detail
QUALITY GATE with a prompt-correction retry loop that auto-fixes both muddy
(too-dense) and thin/line-like (too-sparse) outputs.
"""

# Grid dimensions
GRID_WIDTH = 40
GRID_HEIGHT = 40
TOTAL_PIXELS = GRID_WIDTH * GRID_HEIGHT  # 1600
BITMAP_BYTES = TOTAL_PIXELS // 8         # 200

# Binarization threshold (0-255): <= THRESHOLD -> 1 (character ink), else background.
THRESHOLD = 128

# On-chain / preview render colors. bit=1 -> FG (the character), bit=0 -> BG (canvas).
RENDER_BG = "#EDE8DE"    # broken-white paper
RENDER_FG = "#4E5666"    # soft slate ink (not pure black -> softer contrast)

# Flux models on Replicate. klein is the cheap collection-scale model; schnell for
# rough iteration; dev for a higher-detail pass (e.g. rare 1/1s).
DEFAULT_FLUX_MODEL = "klein"
FLUX_MODELS = {
    "dev": "black-forest-labs/flux-dev",
    "imagen-fast": "google/imagen-4-fast",
    "klein": "black-forest-labs/flux-2-klein-4b",
    "seedream": "bytedance/seedream-4",
    "schnell": "black-forest-labs/flux-schnell",
}

# Shared source-art suffix appended to every prompt. Flux must produce a normal,
# high-resolution graphic portrait; binarize.py is the only stage that creates pixels.
# Asking the model for pixel/1-bit art here causes destructive double quantization.
PROMPT_STYLE_SUFFIX = (
    "high-resolution monochrome editorial mascot portrait source, smooth continuous antialiased edges, "
    "front-facing profile-picture composition, head and face occupy most of the frame, "
    "show the complete neck and both upper shoulders clearly, crop naturally just below the collarbones, "
    "leave white separation around the shoulder silhouette and use a light simple top with dark edge shapes, "
    "keep the complete head hair natural ears and headwear comfortably inside the canvas with generous white headroom, "
    "never touch the top edge and never squash stretch or flatten the head, "
    "clearly separated eyes eyebrows nose mouth cheeks and jaw, readable facial expression, "
    "playful charismatic collectible character with a memorable silhouette, subtle mischievous energy, "
    "PFP-ready and appealing rather than formal ID photography, "
    "build the portrait from separate flat dark shape islands and open white face planes, "
    "use no continuous outer contour and no line-drawing construction, "
    "eyes eyebrows nose mouth hair and accessory are distinct bold shadow shapes separated by white space, "
    "simple readable neckline and two unmistakable shoulder slopes made from separate flat shapes, centered on a pure solid white background, "
    "natural casual personal style, no uniform, smooth uninterrupted head-top silhouette without stray protrusions, "
    "no pixel art, no bitmap aesthetic, no dithering, no hatching, no stippling, no texture fill, "
    "no thin outlines, no ink drawing, no grey fill, no shaded jacket, no large torso, "
    "no solid black clothing mass, no gradients, no photorealism, "
    "no text, no watermark"
)

# Public trait schema. The first seven bytes are rendered as metadata; byte 7
# carries a hidden visual seed so every token can remain reproducibly distinct.
CHARACTER_TYPES = {
    0: "alien",
    1: "ape",
    2: "zombie",
    3: "female",
    4: "male",
}

# Exact collection-level counts. These are shuffled deterministically, never sampled.
TYPE_COUNTS = [2, 4, 16, 681, 1073]
TYPE_WEIGHTS = TYPE_COUNTS  # compatibility for legacy helpers; production uses exact allocation.

# bytes8 layout: Type, Headwear, Eyes, Mouth, Jewelry, Face, Accessory, VisualSeed.
TRAIT_CATEGORIES = [
    ("Type", 4),
    ("Headwear", 8),
    ("Eyes", 4),
    ("Mouth", 6),
    ("Jewelry", 4),
    ("Face", 4),
    ("Accessory", 15),
    ("VisualSeed", 255),
]

# Generation settings
MAX_RETRIES = 3
MAX_SUPPLY = 1776

# Flux generation parameters
FLUX_PARAMS = {}

FLUX_MODEL_PARAMS = {
    "dev": {
        "aspect_ratio": "1:1",
        "output_format": "png",
        "num_outputs": 1,
    },
    "imagen-fast": {
        "aspect_ratio": "1:1",
        "output_format": "png",
    },
    "klein": {
        "aspect_ratio": "1:1",
        "output_format": "png",
        "output_megapixels": "1",
    },
    "seedream": {
        "aspect_ratio": "1:1",
        "size": "1K",
        "max_images": 1,
        "sequential_image_generation": "disabled",
    },
    "schnell": {
        "aspect_ratio": "1:1",
        "output_format": "png",
        "megapixels": "1",
        "num_outputs": 1,
        "num_inference_steps": 4,
    },
}
