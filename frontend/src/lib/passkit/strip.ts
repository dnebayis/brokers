import { INK, encodePngRgba, type Rgb } from "./png.ts";
import { drawArt, drawText, measureText, newCanvas } from "./font.ts";

// The card's middle band (Apple's "strip" image, 375 x 144 pt), drawn by us because Wallet
// allows a single text colour per pass and the owner wants colour: the Broker's art on the
// left, the Broker number in the site's accent, the balance and the stocks in the site's
// green, all in the Silkscreen pixel font the site uses.

// Apple's allotted strip for store cards is 375 x 144 pt; a different aspect gets scaled to
// fill and cropped (which is exactly what cut the art off at 375 x 123).
export const STRIP_W = 375;
export const STRIP_H = 144;

export const STRIP_COLORS: Record<"accent" | "good" | "label", Rgb> = {
  accent: [0xa6, 0x41, 0x2f], // --c-accent (light theme), also the glyph's flag pin
  good: [0x2f, 0x6b, 0x52], // --c-good (light theme)
  label: [0x75, 0x7b, 0x8a], // pass labelColor
};

export type StripInput = {
  id: number;
  art: Uint8Array | null;
  balanceText: string; // already formatted, e.g. "$2.12"
  symbols: string[]; // wallet holdings, most valuable first
};

// Layout in points (1x). Text y is the top of the font's 11-row cell; caps sit on rows 4-8.
const ART_X = 20;
const ART_SCALE = 3; // 40 cells -> 120 pt, centred in the 144 pt band
const ART_Y = (STRIP_H - 40 * ART_SCALE) / 2; // 12
const TEXT_X = ART_X + 40 * ART_SCALE + 16; // 156
const RIGHT_MARGIN = 14;
const LINE_ID_Y = 18;
const LINE_LABEL_Y = 42;
const LINE_BALANCE_Y = 56;
const BALANCE_SCALE = 3; // 24 pt
const LINE_STOCKS_Y = 108;
const SEPARATOR = " · ";

/** Join the symbols with " · ", dropping the tail (as "+N") until the line fits. */
export function stocksLine(symbols: string[], maxWidth: number, scale = 1): string {
  if (symbols.length === 0) return "NONE YET";
  for (let keep = symbols.length; keep >= 1; keep--) {
    const rest = symbols.length - keep;
    const text = symbols.slice(0, keep).join(SEPARATOR) + (rest > 0 ? ` +${rest}` : "");
    if (measureText(text, scale) <= maxWidth) return text;
  }
  return `${symbols[0].slice(0, 6)} +${symbols.length - 1}`;
}

export function stripPng(input: StripInput, scale: 1 | 2 | 3): Buffer {
  const c = newCanvas(STRIP_W * scale, STRIP_H * scale, null); // transparent: one ground, the pass background
  const textX = (input.art ? TEXT_X : ART_X) * scale;
  if (input.art) drawArt(c, ART_X * scale, ART_Y * scale, input.art, ART_SCALE * scale, INK);
  drawText(c, textX, LINE_ID_Y * scale, `BROKER #${input.id}`, scale, STRIP_COLORS.accent);
  drawText(c, textX, LINE_LABEL_Y * scale, "IN THE WALLET", scale, STRIP_COLORS.label);
  drawText(c, textX, LINE_BALANCE_Y * scale, input.balanceText.toUpperCase(), BALANCE_SCALE * scale, STRIP_COLORS.good);
  const maxWidth = STRIP_W * scale - textX - RIGHT_MARGIN * scale;
  drawText(c, textX, LINE_STOCKS_Y * scale, stocksLine(input.symbols, maxWidth, scale), scale, STRIP_COLORS.good);
  return encodePngRgba(c.width, c.height, c.rgba);
}
