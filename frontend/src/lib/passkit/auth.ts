import { passTokenMatches } from "./token";
import { getPass, type PassRecord } from "./store";
import { type PasskitConfig } from "./config";

// PassKit web-service authorization: `Authorization: ApplePass <token>`, where the token is
// the one baked into the pass at issue time (bound to Broker + owner). Returns the record the
// token belongs to, or null.

export function serialToId(serial: string): number | null {
  const id = Number(serial);
  return Number.isInteger(id) && id > 0 && id <= 100_000 ? id : null;
}

export async function authorizedRecord(cfg: PasskitConfig, request: Request, passTypeId: string, serial: string): Promise<PassRecord | null> {
  if (passTypeId !== cfg.passTypeId) return null;
  const id = serialToId(serial);
  if (id === null) return null;
  const header = request.headers.get("authorization") ?? "";
  const m = /^ApplePass\s+([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return null;
  const record = await getPass(id);
  if (!record) return null;
  return passTokenMatches(cfg.authSecret, id, record.owner, m[1].toLowerCase()) ? record : null;
}
