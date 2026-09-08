import { artPng, ART_BYTES } from "./png.ts";

// The Coattail mark (the Broker portrait from public/brand/logo-mark.png) as the same 40x40
// 1-bit bitmap format the on-chain renderer uses, so the pass logo is drawn crisp at every
// scale by the same encoder as the art, instead of resampling a PNG.
const LOGO_HEX =
  "0000000000000000000000001800000003ff80000003ffc000001ffff000001ffff800003ffffe00007ffffc0001fffffe0000ffffff0000ffffff8000ff79ff8001fe70ffc001fe10bf0003fc001f8001ffc3df8001ffffff8003ffffffc000ffe7ff0000ffe7ff0000ffffff8000ffddff8000733c4e00007b3cfe00002f00fc00003bffdc000039ffdc00001cff1800001d1c3800000f08f000000780f0000003c1e0000002ff80000006ff2000003cff3c0000f1412f0003f8410fe00ffc631ff83ffe22bffe";

export const LOGO_BITMAP: Uint8Array = Uint8Array.from(Buffer.from(LOGO_HEX, "hex"));
if (LOGO_BITMAP.length !== ART_BYTES) throw new Error("logo bitmap must be 200 bytes");

/** Apple's pass logo slot is 50pt tall; 40px of art + a 5px margin each side = 50 x 50 pt. */
export const LOGO_MARGIN = 5;
export const logoPng = (scale: 1 | 2 | 3): Buffer => artPng(LOGO_BITMAP, scale, undefined, undefined, LOGO_MARGIN);
