import { encodePngRgba, type Rgb } from "./png.ts";
import { drawText, measureText, newCanvas, setPixel, type Canvas } from "./font.ts";

// The site's header lockup, pixel for pixel (`components/Header.tsx`): the 10x10 broker
// glyph (`ui/BrokerMark.tsx`) inside its 34pt bordered box with the pixel shadow, then
// "COATTAIL / BROKERS" in Silkscreen and "MIRROR CONGRESS" underneath. Rendered as the
// pass logo image (Apple allots 160 x 50 pt) so the card shows the real wordmark instead of
// Wallet's system-font logoText.

const INK: Rgb = [0x4e, 0x56, 0x66]; // --c-ink, also --c-shadow
const INK_STRONG: Rgb = [0x34, 0x39, 0x45]; // --c-ink-strong
const INK_SOFT: Rgb = [0x75, 0x7b, 0x8a]; // --c-ink-soft
const CREAM2: Rgb = [0xf5, 0xf2, 0xeb]; // --c-cream2, the box fill
const SHIRT: Rgb = [0xf5, 0xf2, 0xeb];
const PIN: Rgb = [0xa6, 0x41, 0x2f];

/** Same rects, same order, as the header SVG (x, y, w, h, colour) on a 10x10 grid. */
const RECTS: [number, number, number, number, Rgb][] = [
  [3, 1, 4, 3, INK],
  [2, 2, 1, 2, INK],
  [7, 2, 1, 2, INK],
  [2, 5, 6, 3, INK],
  [4, 5, 2, 3, SHIRT],
  [4, 5, 2, 1, PIN],
];

export function glyphAt(x: number, y: number): Rgb | null {
  let c: Rgb | null = null;
  for (const [rx, ry, rw, rh, colour] of RECTS) {
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) c = colour;
  }
  return c;
}

// Layout in points at 1x, mirroring the header: 34pt box (2pt border, 2pt shadow), 20pt
// glyph (2pt per cell), 12pt gap, 16pt title lines, 8pt subtitle.
export const LOGO_H = 50;
const BOX = 34;
const BORDER = 2;
const SHADOW = 2;
const BOX_Y = 6;
const GLYPH_CELL = 2;
const GLYPH_OFF = (BOX - 10 * GLYPH_CELL) / 2; // 7
const TEXT_X = BOX + SHADOW + 10; // 46
const TITLE_SCALE = 2; // 16pt lines (the site sets 15px)
const TITLE1_Y = 1; // caps land on 9..18
const TITLE2_Y = 15; // caps land on 23..32
const SUB_Y = 34; // caps land on 38..42
const TITLE1 = "COATTAIL";
const TITLE2 = "BROKERS";
const SUBTITLE = "MIRROR CONGRESS";
export const LOGO_W = TEXT_X + Math.max(measureText(TITLE1, TITLE_SCALE), measureText(TITLE2, TITLE_SCALE), measureText(SUBTITLE)) + 2;

function fill(c: Canvas, x: number, y: number, w: number, h: number, colour: Rgb): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPixel(c, xx, yy, colour);
}

/** Transparent outside the box and the letters: the pass background is the only ground. */
export function logoPng(scale: 1 | 2 | 3): Buffer {
  const s = scale;
  const c = newCanvas(LOGO_W * s, LOGO_H * s, null);
  // box: shadow, border, fill
  fill(c, SHADOW * s, (BOX_Y + SHADOW) * s, BOX * s, BOX * s, INK);
  fill(c, 0, BOX_Y * s, BOX * s, BOX * s, INK);
  fill(c, BORDER * s, (BOX_Y + BORDER) * s, (BOX - 2 * BORDER) * s, (BOX - 2 * BORDER) * s, CREAM2);
  // glyph, 2pt per cell, centred in the box
  for (let gy = 0; gy < 10; gy++) {
    for (let gx = 0; gx < 10; gx++) {
      const colour = glyphAt(gx, gy);
      if (colour) fill(c, (GLYPH_OFF + gx * GLYPH_CELL) * s, (BOX_Y + GLYPH_OFF + gy * GLYPH_CELL) * s, GLYPH_CELL * s, GLYPH_CELL * s, colour);
    }
  }
  // wordmark
  drawText(c, TEXT_X * s, TITLE1_Y * s, TITLE1, TITLE_SCALE * s, INK_STRONG);
  drawText(c, TEXT_X * s, TITLE2_Y * s, TITLE2, TITLE_SCALE * s, INK_STRONG);
  drawText(c, TEXT_X * s, SUB_Y * s, SUBTITLE, s, INK_SOFT);
  return encodePngRgba(c.width, c.height, c.rgba);
}
