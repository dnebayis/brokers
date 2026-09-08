import { encodePng, CREAM, type Rgb } from "./png.ts";

// The site's logo, exactly as the header draws it (`components/ui/BrokerMark.tsx`): the
// 10x10 pixel broker glyph, suit + tie + flag pin, in the same three colours. Rendered here
// as PNG for Apple's logo slot instead of resampling an image, so the pixels stay crisp.
const INK: Rgb = [0x4e, 0x56, 0x66];
const SHIRT: Rgb = [0xf5, 0xf2, 0xeb];
const PIN: Rgb = [0xa6, 0x41, 0x2f];

/** Same rects, same order, as the header SVG (x, y, w, h, colour). */
const RECTS: [number, number, number, number, Rgb][] = [
  [3, 1, 4, 3, INK],
  [2, 2, 1, 2, INK],
  [7, 2, 1, 2, INK],
  [2, 5, 6, 3, INK],
  [4, 5, 2, 3, SHIRT],
  [4, 5, 2, 1, PIN],
];

export const GLYPH = 10;
/** Apple's logo slot is 50pt tall: 10 cells x 4px + 5px margin each side = 50 x 50 pt at 1x. */
export const CELL = 4;
export const LOGO_MARGIN = 5;
export const LOGO_SIDE = GLYPH * CELL + LOGO_MARGIN * 2;

/** The glyph's colour at cell (x, y), or null for background. Later rects paint over earlier. */
export function glyphAt(x: number, y: number): Rgb | null {
  let c: Rgb | null = null;
  for (const [rx, ry, rw, rh, colour] of RECTS) {
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) c = colour;
  }
  return c;
}

export function logoPng(scale: 1 | 2 | 3, bg: Rgb = CREAM): Buffer {
  const side = LOGO_SIDE * scale;
  const rgb = new Uint8Array(side * side * 3);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const gx = Math.floor((x - LOGO_MARGIN * scale) / (CELL * scale));
      const gy = Math.floor((y - LOGO_MARGIN * scale) / (CELL * scale));
      const inside = gx >= 0 && gy >= 0 && gx < GLYPH && gy < GLYPH;
      const c = inside ? glyphAt(gx, gy) : null;
      const [r, g, b] = c ?? bg;
      const i = (y * side + x) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }
  return encodePng(side, side, rgb);
}
