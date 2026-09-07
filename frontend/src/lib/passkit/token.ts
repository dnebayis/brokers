import { createHmac, timingSafeEqual } from "node:crypto";

// Every secret the pass layer hands out is derived from one server secret, so nothing has to
// be stored to be checked:
//  - the pass `authenticationToken` (what a phone presents to the PassKit web service) is
//    bound to the Broker AND the owner it was issued to, so a sold Broker's old pass stops
//    authenticating the moment a new owner issues theirs;
//  - the download link is a short-lived signed URL, so the .pkpass can be opened by plain
//    navigation (iOS Safari only offers "Add to Wallet" for a navigated pkpass, not a blob).

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The pass authentication token for (Broker, owner). Apple caps it at 255 chars; 64 hex here. */
export function passToken(secret: string, id: number, owner: string): string {
  return hmac(secret, `pass:${id}:${owner.toLowerCase()}`);
}

export function passTokenMatches(secret: string, id: number, owner: string, presented: string): boolean {
  return safeEqual(passToken(secret, id, owner), presented);
}

const b64u = {
  enc: (s: string) => Buffer.from(s, "utf8").toString("base64url"),
  dec: (s: string) => Buffer.from(s, "base64url").toString("utf8"),
};

/** A signed, expiring download token: `<base64url(id.owner.exp)>.<hmac>`. */
export function downloadToken(secret: string, id: number, owner: string, expiresAtSec: number): string {
  const body = b64u.enc(`${id}.${owner.toLowerCase()}.${expiresAtSec}`);
  return `${body}.${hmac(secret, `download:${body}`)}`;
}

export function parseDownloadToken(
  secret: string,
  token: string,
  nowSec = Math.floor(Date.now() / 1000),
): { id: number; owner: string } | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(hmac(secret, `download:${body}`), sig)) return null;
  const [idText, owner, expText] = b64u.dec(body).split(".");
  const id = Number(idText);
  const exp = Number(expText);
  if (!Number.isInteger(id) || id <= 0 || !/^0x[0-9a-f]{40}$/.test(owner ?? "") || !Number.isFinite(exp)) return null;
  if (exp < nowSec) return null;
  return { id, owner };
}

export { issueMessage, issueExpiryValid, ISSUE_WINDOW_MS } from "./message.ts";
