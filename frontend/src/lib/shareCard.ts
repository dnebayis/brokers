"use client";

// Draws a Broker's earnings card as a PNG, entirely in the browser: the on-chain artwork,
// what it earned since switch-on, what it holds, in the site's own palette and pixel font.
// Nothing leaves the visitor's machine until they post it themselves.

import { ADDR } from "./config";
import { brokerAbi } from "./abis";
import { publicClient as client } from "./client";
import { usd } from "./brokerValue";

export type CardData = {
  id: string;
  active: boolean;
  earnedUsd?: number;
  backingUsd?: number;
  coatInside?: bigint;
  coatUsd?: number;
  symbols: string[];
  gifts?: number;
};

export const CARD_W = 1200;
export const CARD_H = 675;

// The light palette, fixed: a card is shared out of context, so it never follows the theme.
const C = {
  cream: "#ede8de",
  cream2: "#f5f2eb",
  ink: "#4e5666",
  inkStrong: "#343945",
  inkSoft: "#757b8a",
  line: "#cdc7ba",
  brick: "#a6412f",
  good: "#2f6b52",
};

function fontVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `${v}, ${fallback}` : fallback;
}

async function ensureFonts(pixel: string, sans: string): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  try {
    await Promise.all([
      document.fonts.load(`400 40px ${pixel}`),
      document.fonts.load(`700 40px ${pixel}`),
      document.fonts.load(`400 24px ${sans}`),
      document.fonts.load(`500 24px ${sans}`),
    ]);
  } catch {
    /* fall back to whatever the canvas has */
  }
}

/** The Broker's on-chain SVG as a drawable image (an SVG with only a viewBox needs explicit
 *  dimensions before a canvas will rasterize it). */
async function loadArtwork(id: string, px: number): Promise<HTMLImageElement | null> {
  try {
    const uri = await client.readContract({ address: ADDR.broker, abi: brokerAbi, functionName: "tokenURI", args: [BigInt(id)] });
    const prefix = "data:application/json;base64,";
    if (!uri.startsWith(prefix)) return null;
    const image = JSON.parse(atob(uri.slice(prefix.length))).image as string | undefined;
    if (!image) return null;
    let src = image;
    const svgPrefix = "data:image/svg+xml;base64,";
    if (image.startsWith(svgPrefix)) {
      let svg = atob(image.slice(svgPrefix.length));
      if (!/<svg[^>]*\swidth=/.test(svg)) svg = svg.replace(/<svg/, `<svg width="${px}" height="${px}"`);
      src = svgPrefix + btoa(svg);
    }
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("artwork"));
      img.src = src;
    });
  } catch {
    return null;
  }
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

export function shareText(d: CardData): string {
  const site = "coattail.cash";
  if (d.active && d.earnedUsd !== undefined) {
    return `my coattail broker #${d.id} has earned ${usd(d.earnedUsd).toLowerCase()} in tokenized stock since i switched it on. every fee buys stock for holders. check the chain: ${site}`;
  }
  if (d.backingUsd !== undefined && d.backingUsd > 0) {
    return `my coattail broker #${d.id} holds ${usd(d.backingUsd).toLowerCase()} of tokenized stock in its own wallet. check the chain: ${site}`;
  }
  return `my coattail broker #${d.id} is switched off. it starts earning tokenized stock the moment i switch it on. ${site}`;
}

export async function renderShareCard(d: CardData): Promise<Blob> {
  const pixel = fontVar("--font-silkscreen", "monospace");
  const sans = fontVar("--font-grotesk", "system-ui, sans-serif");
  const [art] = await Promise.all([loadArtwork(d.id, 440), ensureFonts(pixel, sans)]);

  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");

  // ground + frame
  ctx.fillStyle = C.cream;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.fillStyle = C.ink;
  ctx.fillRect(22, 22, CARD_W - 44, CARD_H - 44);
  ctx.fillStyle = C.cream2;
  ctx.fillRect(30, 30, CARD_W - 60, CARD_H - 60);
  // pixel corner marks
  for (const [x, y] of [[44, 44], [CARD_W - 60, 44], [44, CARD_H - 60], [CARD_W - 60, CARD_H - 60]]) {
    ctx.fillStyle = C.brick;
    ctx.fillRect(x, y, 16, 16);
  }

  // artwork
  const ax = 78, ay = 96, asz = 440;
  ctx.fillStyle = C.ink;
  ctx.fillRect(ax - 6, ay - 6, asz + 12, asz + 12);
  ctx.fillStyle = C.cream;
  ctx.fillRect(ax, ay, asz, asz);
  if (art) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(art, ax, ay, asz, asz);
  } else {
    ctx.fillStyle = C.inkSoft;
    ctx.font = `400 40px ${pixel}`;
    ctx.textAlign = "center";
    ctx.fillText(`#${d.id}`, ax + asz / 2, ay + asz / 2 + 14);
    ctx.textAlign = "left";
  }

  // identity
  const rx = 580;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.inkSoft;
  ctx.font = `400 20px ${pixel}`;
  ctx.fillText("COATTAIL BROKER", rx, 124);
  ctx.fillStyle = C.inkStrong;
  ctx.font = `700 64px ${pixel}`;
  ctx.fillText(`#${d.id}`, rx, 196);
  const idW = ctx.measureText(`#${d.id}`).width;
  const pill = d.active ? "ACTIVE" : "SWITCHED OFF";
  ctx.font = `400 16px ${pixel}`;
  const pw = ctx.measureText(pill).width + 28;
  const px = rx + idW + 24, py = 156;
  ctx.strokeStyle = d.active ? C.good : C.inkSoft;
  ctx.lineWidth = 3;
  ctx.strokeRect(px, py, pw, 38);
  ctx.fillStyle = d.active ? C.good : C.inkSoft;
  ctx.fillText(pill, px + 14, py + 26);

  // the number that matters
  ctx.fillStyle = C.inkSoft;
  ctx.font = `500 21px ${sans}`;
  if (d.active && d.earnedUsd !== undefined) {
    ctx.fillText("earned in tokenized stock since switch-on", rx, 268);
    ctx.fillStyle = C.brick;
    ctx.font = `700 78px ${pixel}`;
    ctx.fillText(usd(d.earnedUsd), rx, 350);
  } else if (d.backingUsd !== undefined && d.backingUsd > 0) {
    ctx.fillText("tokenized stock inside its own wallet", rx, 268);
    ctx.fillStyle = C.brick;
    ctx.font = `700 78px ${pixel}`;
    ctx.fillText(usd(d.backingUsd), rx, 350);
  } else {
    ctx.fillText("not earning yet", rx, 268);
    ctx.fillStyle = C.brick;
    ctx.font = `700 60px ${pixel}`;
    ctx.fillText("SWITCH IT ON", rx, 340);
  }

  // what it holds
  const lines: string[] = [];
  if (d.active && d.earnedUsd !== undefined && d.backingUsd !== undefined) lines.push(`holds ${usd(d.backingUsd)} of stock right now`);
  if (d.coatInside !== undefined && d.coatInside > 0n) {
    const n = Math.floor(Number(d.coatInside) / 1e18).toLocaleString("en-US");
    lines.push(`${n} $COAT inside${d.coatUsd !== undefined ? ` (${usd(d.coatUsd)})` : ""}`);
  }
  if (d.gifts) lines.push(`${d.gifts} NFT gift${d.gifts > 1 ? "s" : ""} inside`);
  ctx.fillStyle = C.ink;
  ctx.font = `400 24px ${sans}`;
  let ly = 410;
  for (const l of lines.slice(0, 3)) {
    ctx.fillText(fit(ctx, l, 560), rx, ly);
    ly += 36;
  }
  if (d.symbols.length > 0) {
    ctx.fillStyle = C.inkSoft;
    ctx.font = `400 15px ${pixel}`;
    ctx.fillText(fit(ctx, d.symbols.slice(0, 8).join(" · "), 560), rx, Math.max(ly + 6, 470));
  }

  // footer
  ctx.fillStyle = C.line;
  ctx.fillRect(78, 572, CARD_W - 156, 3);
  ctx.fillStyle = C.inkStrong;
  ctx.font = `700 22px ${pixel}`;
  ctx.fillText("coattail.cash", 78, 618);
  ctx.fillStyle = C.inkSoft;
  ctx.font = `400 18px ${sans}`;
  ctx.textAlign = "right";
  ctx.fillText("every fee buys stock for holders · check the chain", CARD_W - 78, 617);
  ctx.textAlign = "left";

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png");
  });
}
