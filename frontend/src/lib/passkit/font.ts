import { ART_W, ART_H, pixelAt, type Rgb } from "./png.ts";

// Silkscreen, the site's pixel font, at its 8px design size: every glyph the card needs as
// bit rows on an 11-row cell (9 rows ascent, 2 descent). Extracted once from the Google
// Fonts TTF with Pillow's 1-bit mask, so what the card draws is exactly what the site
// draws, without a font rasteriser on the server. [advance, rows]; bit i = column i.
export const FONT_ROWS = 11;
export const FONT_BASELINE = 9;

const GLYPHS: Record<string, [number, number[]]> = {
  "A": [6, [0,0,0,0,12,18,30,18,18,0,0]],
  "B": [6, [0,0,0,0,14,18,30,18,14,0,0]],
  "C": [6, [0,0,0,0,12,18,2,18,12,0,0]],
  "D": [6, [0,0,0,0,14,18,18,18,14,0,0]],
  "E": [5, [0,0,0,0,14,2,14,2,14,0,0]],
  "F": [5, [0,0,0,0,14,2,14,2,2,0,0]],
  "G": [6, [0,0,0,0,28,2,26,18,12,0,0]],
  "H": [6, [0,0,0,0,18,18,30,18,18,0,0]],
  "I": [3, [0,0,0,0,2,2,2,2,2,0,0]],
  "J": [6, [0,0,0,0,16,16,16,18,12,0,0]],
  "K": [6, [0,0,0,0,18,10,6,10,18,0,0]],
  "L": [5, [0,0,0,0,2,2,2,2,14,0,0]],
  "M": [7, [0,0,0,0,34,54,42,34,34,0,0]],
  "N": [7, [0,0,0,0,34,38,42,50,34,0,0]],
  "O": [6, [0,0,0,0,12,18,18,18,12,0,0]],
  "P": [6, [0,0,0,0,14,18,14,2,2,0,0]],
  "Q": [6, [0,0,0,0,12,18,18,18,12,16,0]],
  "R": [6, [0,0,0,0,14,18,14,10,18,0,0]],
  "S": [6, [0,0,0,0,28,2,12,16,14,0,0]],
  "T": [5, [0,0,0,0,14,4,4,4,4,0,0]],
  "U": [6, [0,0,0,0,18,18,18,18,12,0,0]],
  "V": [7, [0,0,0,0,34,34,20,20,8,0,0]],
  "W": [7, [0,0,0,0,34,42,42,42,20,0,0]],
  "X": [7, [0,0,0,0,34,20,8,20,34,0,0]],
  "Y": [7, [0,0,0,0,34,20,8,8,8,0,0]],
  "Z": [5, [0,0,0,0,14,8,4,2,14,0,0]],
  "0": [6, [0,0,0,0,12,18,18,18,12,0,0]],
  "1": [5, [0,0,0,0,6,4,4,4,14,0,0]],
  "2": [6, [0,0,0,0,14,16,12,2,30,0,0]],
  "3": [6, [0,0,0,0,14,16,12,16,14,0,0]],
  "4": [6, [0,0,0,0,10,10,30,8,8,0,0]],
  "5": [6, [0,0,0,0,30,2,14,16,14,0,0]],
  "6": [6, [0,0,0,0,12,2,14,18,12,0,0]],
  "7": [6, [0,0,0,0,30,16,8,4,4,0,0]],
  "8": [6, [0,0,0,0,12,18,12,18,12,0,0]],
  "9": [6, [0,0,0,0,12,18,28,16,12,0,0]],
  " ": [4, [0,0,0,0,0,0,0,0,0,0,0]],
  "$": [6, [0,0,0,8,28,2,12,16,14,4,0]],
  ".": [3, [0,0,0,0,0,0,0,2,0,0,0]],
  ",": [4, [0,0,0,0,0,0,0,4,2,0,0]],
  "+": [7, [0,0,0,0,8,8,62,8,8,0,0]],
  "-": [5, [0,0,0,0,0,0,14,0,0,0,0]],
  "#": [7, [0,0,0,0,20,62,20,62,20,0,0]],
  "<": [5, [0,0,0,0,8,4,2,4,8,0,0]],
  "%": [7, [0,0,0,0,22,22,8,52,52,0,0]],
  "(": [4, [0,0,0,0,4,2,2,2,4,0,0]],
  ")": [4, [0,0,0,0,2,4,4,4,2,0,0]],
  "/": [5, [0,0,0,0,8,8,4,2,2,0,0]],
  "·": [3, [0,0,0,0,0,0,2,0,0,0,0]],
  ":": [3, [0,0,0,0,0,2,0,2,0,0,0]],
};
const UNKNOWN: [number, number[]] = [5, [0, 0, 0, 0, 14, 10, 10, 10, 14, 0, 0]]; // a box

export function glyph(ch: string): [number, number[]] {
  return GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? UNKNOWN;
}

/** Width in device pixels of `text` drawn at `scale` device pixels per font pixel. */
export function measureText(text: string, scale = 1): number {
  let w = 0;
  for (const ch of text) w += glyph(ch)[0];
  return w * scale;
}

/** RGBA pixels; a `null` background leaves the canvas transparent so Wallet's own pass
 *  background shows through (an opaque cream rectangle reads as a lighter patch on the card). */
export type Canvas = { width: number; height: number; rgba: Uint8Array };

export function newCanvas(width: number, height: number, bg: Rgb | null): Canvas {
  const rgba = new Uint8Array(width * height * 4);
  if (bg) {
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = bg[0];
      rgba[i * 4 + 1] = bg[1];
      rgba[i * 4 + 2] = bg[2];
      rgba[i * 4 + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/** Paint one pixel, fully opaque. */
export function setPixel(c: Canvas, x: number, y: number, colour: Rgb): void {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const i = (y * c.width + x) * 4;
  c.rgba[i] = colour[0];
  c.rgba[i + 1] = colour[1];
  c.rgba[i + 2] = colour[2];
  c.rgba[i + 3] = 255;
}

/** Fill a `size`-pixel square at (x, y); silently clipped at the edges. */
function block(c: Canvas, x: number, y: number, size: number, colour: Rgb): void {
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) setPixel(c, x + dx, y + dy, colour);
}

/** Draw `text` with its 11-row cell's top-left at (x, y). Returns the x after the text. */
export function drawText(c: Canvas, x: number, y: number, text: string, scale: number, colour: Rgb): number {
  let cx = x;
  for (const ch of text) {
    const [adv, rows] = glyph(ch);
    for (let r = 0; r < FONT_ROWS; r++) {
      const bits = rows[r];
      if (!bits) continue;
      for (let col = 0; col < 8; col++) {
        if (bits & (1 << col)) block(c, cx + col * scale, y + r * scale, scale, colour);
      }
    }
    cx += adv * scale;
  }
  return cx;
}

/** Draw the 40x40 Broker bitmap with its top-left at (x, y), `scale` pixels per cell. */
export function drawArt(c: Canvas, x: number, y: number, bitmap: Uint8Array, scale: number, ink: Rgb): void {
  for (let by = 0; by < ART_H; by++) {
    for (let bx = 0; bx < ART_W; bx++) {
      if (pixelAt(bitmap, bx, by)) block(c, x + bx * scale, y + by * scale, scale, ink);
    }
  }
}
