import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import forge from "node-forge";
import { PKPass } from "passkit-generator";
import { artPng, pixelAt, encodePng, ART_BYTES } from "../src/lib/passkit/png.ts";
import { passToken, passTokenMatches, downloadToken, parseDownloadToken } from "../src/lib/passkit/token.ts";
import { issueMessage, issueExpiryValid } from "../src/lib/passkit/message.ts";
import { buildPassJson, usdText } from "../src/lib/passkit/pass.ts";
import { logoPng, glyphAt, LOGO_W } from "../src/lib/passkit/logo.ts";
import { measureText, drawText, newCanvas } from "../src/lib/passkit/font.ts";
import { stripPng, stocksLine } from "../src/lib/passkit/strip.ts";
import { advance, payoutValue, pushWorthy, DRIFT_REFRESH_SEC } from "../src/lib/passkit/record.ts";

// ── art → PNG ────────────────────────────────────────────────────────────────
function bitmapWith(setPixels) {
  const b = new Uint8Array(ART_BYTES);
  for (const [x, y] of setPixels) {
    const idx = y * 40 + x;
    b[idx >> 3] |= 1 << (7 - (idx & 7));
  }
  return b;
}

function decodePng(buf) {
  assert.equal(buf.readUInt32BE(16), buf.readUInt32BE(20)); // square
  const width = buf.readUInt32BE(16);
  // single IDAT right after IHDR (8 sig + 25 IHDR chunk)
  const idatLen = buf.readUInt32BE(33);
  assert.equal(buf.toString("ascii", 37, 41), "IDAT");
  const raw = inflateSync(buf.subarray(41, 41 + idatLen));
  return { width, raw };
}

test("bitmap bit order matches the renderer (MSB first, row-major)", () => {
  const b = bitmapWith([[0, 0], [39, 0], [7, 1]]);
  assert.equal(b[0] & 0x80, 0x80);
  assert.ok(pixelAt(b, 0, 0));
  assert.ok(pixelAt(b, 39, 0));
  assert.ok(pixelAt(b, 7, 1));
  assert.ok(!pixelAt(b, 1, 0));
});

test("artPng scales pixels exactly and paints ink/cream", () => {
  const b = bitmapWith([[0, 0]]);
  const png = artPng(b, 2);
  const { width, raw } = decodePng(png);
  assert.equal(width, 80);
  const stride = 80 * 3 + 1;
  const px = (x, y) => [raw[y * stride + 1 + x * 3], raw[y * stride + 2 + x * 3], raw[y * stride + 3 + x * 3]];
  assert.deepEqual(px(0, 0), [0x4e, 0x56, 0x66]);
  assert.deepEqual(px(1, 1), [0x4e, 0x56, 0x66]); // 2x2 block
  assert.deepEqual(px(2, 0), [0xed, 0xe8, 0xde]);
  assert.throws(() => artPng(new Uint8Array(10), 1), /200 bytes/);
});

test("encodePng rejects a mismatched buffer", () => {
  assert.throws(() => encodePng(2, 2, new Uint8Array(5)), /mismatch/);
});

// ── tokens ───────────────────────────────────────────────────────────────────
const SECRET = "s".repeat(48);

test("pass token binds Broker and owner, case-insensitive on the address", () => {
  const t = passToken(SECRET, 527, "0xAbC0000000000000000000000000000000000001");
  assert.equal(t.length, 64);
  assert.ok(passTokenMatches(SECRET, 527, "0xabc0000000000000000000000000000000000001", t));
  assert.ok(!passTokenMatches(SECRET, 528, "0xabc0000000000000000000000000000000000001", t));
  assert.ok(!passTokenMatches(SECRET, 527, "0xabc0000000000000000000000000000000000002", t));
  assert.ok(!passTokenMatches("other".repeat(10), 527, "0xabc0000000000000000000000000000000000001", t));
});

test("download token round-trips and expires", () => {
  const owner = "0x" + "a".repeat(40);
  const t = downloadToken(SECRET, 12, owner, 1000);
  assert.deepEqual(parseDownloadToken(SECRET, t, 999), { id: 12, owner });
  assert.equal(parseDownloadToken(SECRET, t, 1001), null);
  assert.equal(parseDownloadToken(SECRET, t + "x", 999), null);
  assert.equal(parseDownloadToken("wrong".repeat(10), t, 999), null);
});

test("issue message names everything and the expiry window is bounded", () => {
  const m = issueMessage({ id: 5, address: "0x" + "b".repeat(40), chainId: 4663, expiresAt: "2026-01-01T00:00:00.000Z" });
  assert.match(m, /Broker #5/);
  assert.match(m, /chain: 4663/);
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.ok(issueExpiryValid(new Date(now + 60_000).toISOString(), now));
  assert.ok(!issueExpiryValid(new Date(now - 1).toISOString(), now));
  assert.ok(!issueExpiryValid(new Date(now + 3 * 3600_000).toISOString(), now));
  assert.ok(!issueExpiryValid("garbage", now));
});

// ── pass.json ────────────────────────────────────────────────────────────────
const issuer = { name: "Coattail Brokers", address: "somewhere", email: "hello@coattail.cash" };
const base = {
  id: 527,
  owner: "0x" + "a".repeat(40),
  liveOwner: "0x" + "A".repeat(40),
  active: true,
  wallet: "0x" + "c".repeat(40),
  balanceUsd: 12.345,
  claimableUsd: 0.5,
  lastPayoutUsd: 0.31,
  holdings: [
    { symbol: "INTC", formatted: "0.12", usd: 10 },
    { symbol: "SPCX", formatted: "0.01", usd: 2.345 },
    { symbol: "COAT", formatted: "1000", usd: null },
  ],
  updatedAt: 1_700_000_000,
  siteOrigin: "https://www.coattail.cash",
  explorerBase: "https://robinhoodchain.blockscout.com",
  chainId: 4663,
  passTypeIdentifier: "pass.cash.coattail.broker",
  teamIdentifier: "ABCDE12345",
  issuer,
  webService: { url: "https://www.coattail.cash/api/passkit", authenticationToken: "t".repeat(64) },
};

test("pass.json carries the numbers, the issuer contact and the web service", () => {
  const p = buildPassJson(base);
  assert.equal(p.serialNumber, "527");
  assert.equal(p.voided, undefined);
  assert.equal(p.webServiceURL, base.webService.url);
  assert.equal(p.authenticationToken, base.webService.authenticationToken);
  assert.equal(p.sharingProhibited, true);
  const g = p.storeCard;
  assert.equal(p.generic, undefined);
  assert.equal(g.headerFields[0].value, "ACTIVE");
  assert.equal(g.primaryFields, undefined); // the strip image carries the coloured numbers
  assert.equal(g.secondaryFields[0].value, "+$0.31");
  assert.match(g.secondaryFields[0].changeMessage, /%@/);
  assert.equal(g.secondaryFields[1].value, "$0.50");
  const back = Object.fromEntries(g.backFields.map((f) => [f.key, f.value]));
  assert.equal(back["balance"], "$12.35");
  assert.equal(g.backFields.find((f) => f.key === "balance").changeMessage, undefined); // one change message per event
  const withMessages = [...g.headerFields, ...g.secondaryFields, ...g.backFields].filter((f) => f.changeMessage);
  assert.deepEqual(withMessages.map((f) => f.key), ["status", "payout"]);
  assert.equal(back["stocks"], "INTC, SPCX, COAT");
  assert.equal(back["broker"], "#527");
  assert.equal(back["issuer-contact"], issuer.email);
  assert.equal(back["issuer-address"], issuer.address);
  assert.equal(back["h-COAT"], "1000");
  assert.equal(back["h-INTC"], "0.12 ($10.00)");
  assert.equal(p.barcodes, undefined); // one-colour card: no white barcode panel
  assert.equal(back["card"], "https://www.coattail.cash/card/527");
});

test("a sold Broker's pass is voided and says so", () => {
  const p = buildPassJson({ ...base, liveOwner: "0x" + "d".repeat(40) });
  assert.equal(p.voided, true);
  assert.equal(p.storeCard.headerFields[0].value, "SOLD");
  assert.ok(p.storeCard.backFields.some((f) => f.key === "sold"));
});

test("without a web service the pass has neither URL nor token", () => {
  const p = buildPassJson({ ...base, webService: undefined });
  assert.equal(p.webServiceURL, undefined);
  assert.equal(p.authenticationToken, undefined);
});

test("usdText formats the edge cases", () => {
  assert.equal(usdText(null), "—");
  assert.equal(usdText(0), "$0.00");
  assert.equal(usdText(0.004), "<$0.01");
  assert.equal(usdText(1234.5), "$1,234.50");
});

// ── record transitions ───────────────────────────────────────────────────────
const prev = {
  owner: "0x" + "a".repeat(40),
  active: true,
  units: { INTC: "1000", SPCX: "500" },
  balanceUsd: 10,
  claimableUsd: 0,
  lastPayoutUsd: null,
  voided: false,
  updatedAt: 100,
};
const live = (over = {}) => ({
  liveOwner: "0x" + "A".repeat(40),
  active: true,
  units: { INTC: "1000", SPCX: "500" },
  holdings: [
    { symbol: "INTC", usd: 8, units: "1000" },
    { symbol: "SPCX", usd: 2, units: "500" },
  ],
  balanceUsd: 10,
  claimableUsd: 0,
  ...over,
});

test("nothing changed → no update", () => {
  const r = advance(prev, live(), 200);
  assert.equal(r.changed, false);
  assert.equal(r.next.updatedAt, 100);
});

test("a price move alone is never a payout and never a push: silent drift, at most hourly", () => {
  const moved = live({ balanceUsd: 11, holdings: [{ symbol: "INTC", usd: 9, units: "1000" }, { symbol: "SPCX", usd: 2, units: "500" }] });
  // within the hour: nothing changes, Last-Modified stays put
  const soon = advance(prev, moved, 200);
  assert.deepEqual(soon.reasons, []);
  assert.equal(soon.changed, false);
  assert.equal(soon.next.updatedAt, 100);
  assert.equal(soon.next.balanceUsd, 11); // the numbers still travel with the record
  // an hour later: a silent refresh, still not worth a ping
  const later = advance(prev, moved, 100 + DRIFT_REFRESH_SEC);
  assert.deepEqual(later.reasons, ["drift"]);
  assert.equal(later.next.lastPayoutUsd, null);
  assert.equal(later.next.updatedAt, 100 + DRIFT_REFRESH_SEC);
  assert.equal(pushWorthy(later.reasons), false);
  assert.equal(pushWorthy(["payout"]), true);
  assert.equal(pushWorthy(["drift", "switched-off"]), true);
});

test("more units = payout, valued at today's prices for the new slice", () => {
  const l = live({
    units: { INTC: "1100", SPCX: "500" },
    holdings: [{ symbol: "INTC", usd: 11, units: "1100" }, { symbol: "SPCX", usd: 2, units: "500" }],
    balanceUsd: 13,
  });
  assert.ok(Math.abs(payoutValue(prev.units, l) - 1) < 0.01);
  const r = advance(prev, l, 300);
  assert.ok(r.reasons.includes("payout"));
  assert.ok(Math.abs(r.next.lastPayoutUsd - 1) < 0.01);
  assert.equal(r.next.units.INTC, "1100");
});

test("a new symbol counts as a payout too", () => {
  const l = live({ units: { INTC: "1000", SPCX: "500", MU: "7" }, holdings: [...live().holdings, { symbol: "MU", usd: 0.5, units: "7" }] });
  const r = advance(prev, l, 300);
  assert.ok(r.reasons.includes("payout"));
  assert.ok(Math.abs(r.next.lastPayoutUsd - 0.5) < 1e-9);
});

test("sold → voided once, units frozen, no payouts for the old owner", () => {
  const sold = live({ liveOwner: "0x" + "e".repeat(40), units: { INTC: "5000" }, holdings: [{ symbol: "INTC", usd: 40, units: "5000" }], balanceUsd: 40 });
  const r = advance(prev, sold, 300);
  assert.deepEqual(r.reasons, ["sold"]);
  assert.equal(r.next.voided, true);
  assert.deepEqual(r.next.units, prev.units);
  const again = advance(r.next, sold, 400);
  assert.equal(again.changed, false);
});

test("switching off is a change", () => {
  const r = advance(prev, live({ active: false }), 300);
  assert.deepEqual(r.reasons, ["switched-off"]);
});

// ── signing with a throwaway certificate ─────────────────────────────────────
function selfSigned() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: "commonName", value: "Pass Type ID: pass.test" }, { name: "organizationName", value: "test" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

test("the logo is the site's header lockup: boxed glyph + COATTAIL / BROKERS + MIRROR CONGRESS", () => {
  const dims = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.ok(LOGO_W <= 160 && LOGO_W > 100, `logo width ${LOGO_W}`); // Apple allots 160 x 50 pt
  assert.deepEqual(dims(logoPng(1)), [LOGO_W, 50]);
  assert.deepEqual(dims(logoPng(2)), [LOGO_W * 2, 100]);
  assert.deepEqual(dims(logoPng(3)), [LOGO_W * 3, 150]);
  // cells match components/ui/BrokerMark.tsx: suit ink, shirt light, pin red, corners empty
  assert.deepEqual(glyphAt(3, 1), [0x4e, 0x56, 0x66]);
  assert.deepEqual(glyphAt(4, 5), [0xa6, 0x41, 0x2f]);
  assert.deepEqual(glyphAt(4, 6), [0xf5, 0xf2, 0xeb]);
  assert.equal(glyphAt(0, 0), null);
  // rendered pixels: decode the 1x PNG (no filter) and probe the box, the glyph and the text
  const png = logoPng(1);
  const idatLen = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  const px = (x, y) => Array.from(raw.subarray(y * (LOGO_W * 4 + 1) + 1 + x * 4, y * (LOGO_W * 4 + 1) + 5 + x * 4));
  assert.equal(png[25], 6); // colour type 6 = truecolor with alpha
  assert.equal(px(0, 0)[3], 0); // above the box: transparent, the pass background shows
  assert.deepEqual(px(0, 6), [0x4e, 0x56, 0x66, 255]); // box border
  assert.deepEqual(px(3, 9), [0xf5, 0xf2, 0xeb, 255]); // box fill (cream-2)
  assert.deepEqual(px(7 + 4 * 2, 6 + 7 + 5 * 2), [0xa6, 0x41, 0x2f, 255]); // glyph cell (4,5) = pin
  assert.deepEqual(px(35, 41), [0x4e, 0x56, 0x66, 255]); // the 2pt pixel shadow, right of the box
  const strong = new Set();
  for (let y = 0; y < 50; y++) for (let x = 46; x < LOGO_W; x++) strong.add(px(x, y).slice(0, 3).join(","));
  assert.ok(strong.has("52,57,69"), "title drawn in ink-strong");
  assert.ok(strong.has("117,123,138"), "subtitle drawn in ink-soft");
});

test("the Silkscreen glyph table measures and draws like the site's font", () => {
  assert.equal(measureText("A"), 6);
  assert.equal(measureText("BROKER #527"), 6 + 6 + 6 + 6 + 5 + 6 + 4 + 7 + 6 + 6 + 6);
  assert.equal(measureText("ab", 2), measureText("AB") * 2); // lower case maps to the capitals
  const c = newCanvas(20, 11, [0, 0, 0]);
  drawText(c, 0, 0, "I", 1, [255, 255, 255]);
  // "I" is a single column (bit 1) on rows 4..8
  const at = (x, y) => c.rgba[(y * c.width + x) * 4];
  assert.equal(at(1, 4), 255);
  assert.equal(at(1, 8), 255);
  assert.equal(at(1, 3), 0);
  assert.equal(at(0, 4), 0);
});

test("the strip is Apple's 375x144 pt store-card band at 1x/2x/3x with art, an orange number and green money", () => {
  const dims = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)];
  const input = { id: 527, art: bitmapWith([[0, 0], [39, 39]]), balanceText: "$2.12", symbols: ["INTC", "SPCX", "MU"] };
  assert.deepEqual(dims(stripPng(input, 1)), [375, 144]);
  assert.deepEqual(dims(stripPng(input, 2)), [750, 288]);
  assert.deepEqual(dims(stripPng(input, 3)), [1125, 432]);
  const png = stripPng(input, 1);
  const idatLen = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  const px = (x, y) => Array.from(raw.subarray(y * (375 * 4 + 1) + 1 + x * 4, y * (375 * 4 + 1) + 5 + x * 4));
  assert.deepEqual(px(20, 12), [0x4e, 0x56, 0x66, 255]); // art cell (0,0): 3 pt per cell, 20 pt in, 12 pt down
  assert.deepEqual(px(20 + 39 * 3 + 2, 12 + 39 * 3 + 2), [0x4e, 0x56, 0x66, 255]); // art cell (39,39), fully inside
  assert.equal(px(19, 12)[3], 0); // nothing left of the art: transparent
  assert.equal(px(0, 0)[3], 0); // transparent margin, the pass background is the only ground
  const colours = new Set();
  for (let y = 0; y < 144; y++) for (let x = 156; x < 375; x++) colours.add(px(x, y).slice(0, 3).join(","));
  assert.ok(colours.has("166,65,47"), "accent orange present"); // BROKER #527
  assert.ok(colours.has("47,107,82"), "good green present"); // balance + stocks
  assert.ok(colours.has("117,123,138"), "label grey present"); // IN THE WALLET
  // the stocks line trims to the available width
  assert.equal(stocksLine(["INTC", "SPCX", "MU"], 1000), "INTC · SPCX · MU");
  const eight = ["INTC", "SPCX", "MU", "NVDA", "AAPL", "MSFT", "AMD", "META"];
  assert.equal(stocksLine(eight, 120), "INTC · SPCX · MU +5"); // 98 px fits, the next symbol would not
  assert.ok(measureText(stocksLine(eight, 120)) <= 120);
  assert.ok(measureText("INTC · SPCX · MU · NVDA +4") > 120);
  assert.equal(stocksLine([], 100), "NONE YET");
  // no art: text starts at the left margin and the image is still valid
  assert.deepEqual(dims(stripPng({ ...input, art: null }, 2)), [750, 288]);
});

test("the pass.json we build is accepted by passkit-generator and signs into a .pkpass", () => {
  const { cert, key } = selfSigned();
  const passJson = buildPassJson(base);
  const art = artPng(bitmapWith([[3, 3], [4, 4]]), 1);
  const pass = new PKPass(
    { "pass.json": Buffer.from(JSON.stringify(passJson)), "icon.png": art, "icon@2x.png": artPng(bitmapWith([[1, 1]]), 2) },
    { wwdr: cert, signerCert: cert, signerKey: key },
  );
  const buf = pass.getAsBuffer();
  assert.ok(buf.length > 1000);
  assert.equal(buf.readUInt32LE(0), 0x04034b50); // zip local header
  const text = buf.toString("latin1");
  assert.ok(text.includes("manifest.json"));
  assert.ok(text.includes("signature"));
  assert.ok(text.includes("pass.json"));
});
