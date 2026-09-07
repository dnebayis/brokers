import { deflateSync } from "node:zlib";

// The Broker's on-chain artwork is a 40x40 one-bit bitmap (200 bytes, row-major, MSB first,
// bit 1 = ink), the same bytes BrokerRenderer turns into the tokenURI SVG. Wallet passes need
// PNGs, so this is the smallest possible encoder: one RGB image, no filters, zlib from node.
// Rendered in the collection's fixed palette (slate ink on broken white), scaled by an integer
// so the pixels stay crisp.

export const ART_W = 40;
export const ART_H = 40;
export const ART_BYTES = (ART_W * ART_H) / 8;

export type Rgb = [number, number, number];
export const INK: Rgb = [0x4e, 0x56, 0x66];
export const CREAM: Rgb = [0xed, 0xe8, 0xde];

/** Is the pixel at (x, y) inked? Mirrors BrokerRenderer._pixel. */
export function pixelAt(bitmap: Uint8Array, x: number, y: number): boolean {
  const idx = y * ART_W + x;
  return ((bitmap[idx >> 3] >> (7 - (idx & 7))) & 1) === 1;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode an RGB pixel buffer (w*h*3 bytes) as a PNG. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  if (rgb.length !== width * height * 3) throw new Error("rgb buffer size mismatch");
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolor, deflate, no filter, no interlace
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);
}

/** The artwork as a PNG, `scale` device pixels per bitmap pixel, with an optional margin
 *  (in bitmap pixels) of background around it. */
export function artPng(bitmap: Uint8Array, scale: number, fg: Rgb = INK, bg: Rgb = CREAM, margin = 0): Buffer {
  if (bitmap.length !== ART_BYTES) throw new Error(`bitmap must be ${ART_BYTES} bytes, got ${bitmap.length}`);
  if (!Number.isInteger(scale) || scale < 1) throw new Error("scale must be a positive integer");
  const side = (ART_W + margin * 2) * scale;
  const rgb = new Uint8Array(side * side * 3);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const bx = Math.floor(x / scale) - margin;
      const by = Math.floor(y / scale) - margin;
      const inked = bx >= 0 && by >= 0 && bx < ART_W && by < ART_H && pixelAt(bitmap, bx, by);
      const c = inked ? fg : bg;
      const o = (y * side + x) * 3;
      rgb[o] = c[0];
      rgb[o + 1] = c[1];
      rgb[o + 2] = c[2];
    }
  }
  return encodePng(side, side, rgb);
}

/** A flat single-colour PNG (used for the pass logo slot, which must exist on some iOS versions). */
export function solidPng(width: number, height: number, color: Rgb): Buffer {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(color, i * 3);
  return encodePng(width, height, rgb);
}
