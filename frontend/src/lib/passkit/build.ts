import { PKPass } from "passkit-generator";
import { EXPLORER_BASE, activeChain } from "@/lib/chains";
import { kvConfigured } from "@/lib/kv";
import { type PasskitConfig } from "./config";
import { readArt, readBrokerPassState, type BrokerPassState } from "./chain";
import { artPng } from "./png";
import { buildPassJson } from "./pass";
import { advance } from "./record";
import { getPass, putPass, type PassRecord } from "./store";
import { passToken } from "./token";

// Assemble and sign one Broker's pass from the chain and the stored record. Shared by the
// first download and every later re-fetch from a phone, so both always agree.

export type BuiltPass = { buffer: Buffer; record: PassRecord; live: BrokerPassState };

/** Fresh record for a pass issued right now to `owner`. */
export function newRecord(id: number, owner: string, live: BrokerPassState, now: number): PassRecord {
  return {
    id,
    owner: owner.toLowerCase(),
    issuedAt: now,
    updatedAt: now,
    active: live.active,
    units: live.units,
    balanceUsd: live.balanceUsd,
    claimableUsd: live.claimableUsd,
    lastPayoutUsd: null,
    voided: live.owner.toLowerCase() !== owner.toLowerCase(),
  };
}

/** Bring a stored record up to date with the chain; persists when something changed. */
export async function refreshRecord(record: PassRecord, live: BrokerPassState, now: number): Promise<{ record: PassRecord; changed: boolean; reasons: string[] }> {
  const { next, changed, reasons } = advance(record, { liveOwner: live.owner, active: live.active, units: live.units, holdings: live.holdings, balanceUsd: live.balanceUsd, claimableUsd: live.claimableUsd }, now);
  const merged: PassRecord = { ...record, ...next };
  if (changed && kvConfigured()) await putPass(merged);
  return { record: merged, changed, reasons };
}

export async function renderPkpass(cfg: PasskitConfig, record: PassRecord, live: BrokerPassState): Promise<Buffer> {
  const art = await readArt(record.id);
  const passJson = buildPassJson({
    id: record.id,
    owner: record.owner,
    liveOwner: live.owner,
    active: live.active,
    wallet: live.wallet,
    balanceUsd: record.voided ? record.balanceUsd : live.balanceUsd,
    claimableUsd: record.voided ? record.claimableUsd : live.claimableUsd,
    lastPayoutUsd: record.lastPayoutUsd,
    holdings: live.holdings.map((h) => ({ symbol: h.symbol, formatted: h.formatted, usd: h.usd })),
    updatedAt: record.updatedAt,
    siteOrigin: cfg.siteOrigin,
    explorerBase: EXPLORER_BASE,
    chainId: activeChain.id,
    passTypeIdentifier: cfg.passTypeId,
    teamIdentifier: cfg.teamId,
    issuer: cfg.issuer,
    webService: kvConfigured()
      ? { url: cfg.webServiceUrl, authenticationToken: passToken(cfg.authSecret, record.id, record.owner) }
      : undefined,
  });

  const files: Record<string, Buffer> = { "pass.json": Buffer.from(JSON.stringify(passJson)) };
  if (art) {
    files["icon.png"] = artPng(art, 1);
    files["icon@2x.png"] = artPng(art, 2);
    files["icon@3x.png"] = artPng(art, 3);
    files["thumbnail.png"] = artPng(art, 2);
    files["thumbnail@2x.png"] = artPng(art, 4);
    files["thumbnail@3x.png"] = artPng(art, 6);
  } else {
    // art unavailable (renderer unset on this network): a blank icon keeps the pass valid
    const blank = artPng(new Uint8Array(200), 1);
    files["icon.png"] = blank;
    files["icon@2x.png"] = artPng(new Uint8Array(200), 2);
  }
  const pass = new PKPass(files, {
    wwdr: cfg.wwdr,
    signerCert: cfg.signerCert,
    signerKey: cfg.signerKey,
    signerKeyPassphrase: cfg.signerKeyPassphrase,
  });
  return pass.getAsBuffer();
}

/** Issue (or re-issue) a pass to `owner`, who must own the Broker right now. */
export async function issuePass(cfg: PasskitConfig, id: number, owner: string): Promise<BuiltPass | "not-owner" | "no-broker"> {
  const live = await readBrokerPassState(id);
  if (!live) return "no-broker";
  if (live.owner.toLowerCase() !== owner.toLowerCase()) return "not-owner";
  const now = Math.floor(Date.now() / 1000);
  const stored = kvConfigured() ? await getPass(id) : null;
  let record: PassRecord;
  if (stored && stored.owner === owner.toLowerCase()) {
    record = (await refreshRecord(stored, live, now)).record;
  } else {
    record = newRecord(id, owner, live, now);
    if (kvConfigured()) await putPass(record);
  }
  const buffer = await renderPkpass(cfg, record, live);
  return { buffer, record, live };
}

/** Re-render the pass a phone already holds (record must exist). */
export async function refreshPass(cfg: PasskitConfig, record: PassRecord): Promise<BuiltPass | "no-broker"> {
  const live = await readBrokerPassState(record.id);
  if (!live) return "no-broker";
  const now = Math.floor(Date.now() / 1000);
  const fresh = (await refreshRecord(record, live, now)).record;
  const buffer = await renderPkpass(cfg, fresh, live);
  return { buffer, record: fresh, live };
}

export const PKPASS_MIME = "application/vnd.apple.pkpass";
