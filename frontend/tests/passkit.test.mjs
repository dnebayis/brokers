import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import forge from "node-forge";
import { PKPass } from "passkit-generator";
import { artPng, pixelAt, encodePng, ART_BYTES } from "../src/lib/passkit/png.ts";
import { passToken, passTokenMatches, downloadToken, parseDownloadToken } from "../src/lib/passkit/token.ts";
import { issueMessage, issueExpiryValid } from "../src/lib/passkit/message.ts";
import { buildPassJson, usdText } from "../src/lib/passkit/pass.ts";
import { logoPng, LOGO_BITMAP } from "../src/lib/passkit/logo.ts";
import { advance, payoutValue } from "../src/lib/passkit/record.ts";

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
  const g = p.generic;
  assert.equal(g.headerFields[0].value, "ACTIVE");
  assert.equal(g.primaryFields[0].value, "$12.35");
  assert.match(g.primaryFields[0].changeMessage, /%@/);
  assert.equal(g.secondaryFields[0].value, "+$0.31");
  assert.equal(g.secondaryFields[1].value, "INTC, SPCX, COAT");
  const back = Object.fromEntries(g.backFields.map((f) => [f.key, f.value]));
  assert.equal(back["issuer-contact"], issuer.email);
  assert.equal(back["issuer-address"], issuer.address);
  assert.equal(back["h-COAT"], "1000");
  assert.equal(back["h-INTC"], "0.12 ($10.00)");
  assert.equal(p.barcodes[0].message, "https://www.coattail.cash/card/527");
});

test("a sold Broker's pass is voided and says so", () => {
  const p = buildPassJson({ ...base, liveOwner: "0x" + "d".repeat(40) });
  assert.equal(p.voided, true);
  assert.equal(p.generic.headerFields[0].value, "SOLD");
  assert.ok(p.generic.backFields.some((f) => f.key === "sold"));
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

test("a price move alone is a balance change, never a payout", () => {
  const r = advance(prev, live({ balanceUsd: 11, holdings: [{ symbol: "INTC", usd: 9, units: "1000" }, { symbol: "SPCX", usd: 2, units: "500" }] }), 200);
  assert.deepEqual(r.reasons, ["balance"]);
  assert.equal(r.next.lastPayoutUsd, null);
  assert.equal(r.next.updatedAt, 200);
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

test("the logo is the Coattail mark, 50pt square at 1x/2x/3x, drawn by the art encoder", () => {
  const dims = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.deepEqual(dims(logoPng(1)), [50, 50]);
  assert.deepEqual(dims(logoPng(2)), [100, 100]);
  assert.deepEqual(dims(logoPng(3)), [150, 150]);
  assert.equal(LOGO_BITMAP.length, ART_BYTES);
  // the mark has ink (it is not a blank square) and the margin ring stays clear
  let ink = 0;
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (pixelAt(LOGO_BITMAP, x, y)) ink++;
  assert.ok(ink > 400 && ink < 1000, `ink cells ${ink}`);
  for (let x = 0; x < 40; x++) assert.equal(pixelAt(LOGO_BITMAP, x, 0), false);
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
