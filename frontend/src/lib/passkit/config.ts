import { kvConfigured } from "@/lib/kv";

// Apple Wallet pass configuration, all from server env (never NEXT_PUBLIC_):
//
//   PASSKIT_ENABLED             1 to switch the whole feature on (off by default, even with certs)
//   PASSKIT_PASS_TYPE_ID        pass.cash.coattail.broker   (Certificates, Identifiers & Profiles)
//   PASSKIT_TEAM_ID             the 10-character Apple team id
//   PASSKIT_SIGNER_CERT         the Pass Type ID certificate, PEM (raw or base64 of the PEM)
//   PASSKIT_SIGNER_KEY          its private key, PEM (raw or base64)
//   PASSKIT_SIGNER_KEY_PASSPHRASE  optional, if the key is encrypted
//   PASSKIT_WWDR_CERT           Apple WWDR G4 intermediate, PEM (raw or base64)
//   PASSKIT_AUTH_SECRET         random 32+ bytes hex; derives every pass/download token
//   PASSKIT_ISSUER_NAME / PASSKIT_ISSUER_ADDRESS / PASSKIT_ISSUER_EMAIL
//                               printed on the back of the pass (Apple's pass terms, Attachment 5 §2.3)
//   PASSKIT_PUSH_SECRET         bearer for the push sweep (falls back to RECHECK_SECRET)
//   NEXT_PUBLIC_SITE_ORIGIN     https://www.coattail.cash (already set); the web service lives under it
//
// Live updates additionally need the KV store (KV_REST_API_URL / KV_REST_API_TOKEN, the same
// one the sales bot uses). Without it passes still issue, just as static cards.

const str = (k: string): string => (process.env[k] ?? "").trim();

/** PEM given raw, or base64 of the PEM (safer to paste into an env field). */
export function pem(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (v.startsWith("-----BEGIN")) return v.replace(/\\n/g, "\n");
  try {
    const decoded = Buffer.from(v, "base64").toString("utf8");
    return decoded.startsWith("-----BEGIN") ? decoded : "";
  } catch {
    return "";
  }
}

export type PasskitConfig = {
  passTypeId: string;
  teamId: string;
  signerCert: string;
  signerKey: string;
  signerKeyPassphrase?: string;
  wwdr: string;
  authSecret: string;
  issuer: { name: string; address: string; email: string };
  siteOrigin: string;
  webServiceUrl: string;
};

export function passkitConfig(): PasskitConfig | null {
  if (str("PASSKIT_ENABLED") !== "1") return null;
  const cfg: PasskitConfig = {
    passTypeId: str("PASSKIT_PASS_TYPE_ID"),
    teamId: str("PASSKIT_TEAM_ID"),
    signerCert: pem(str("PASSKIT_SIGNER_CERT")),
    signerKey: pem(str("PASSKIT_SIGNER_KEY")),
    signerKeyPassphrase: str("PASSKIT_SIGNER_KEY_PASSPHRASE") || undefined,
    wwdr: pem(str("PASSKIT_WWDR_CERT")),
    authSecret: str("PASSKIT_AUTH_SECRET"),
    issuer: {
      name: str("PASSKIT_ISSUER_NAME") || "Coattail Brokers",
      address: str("PASSKIT_ISSUER_ADDRESS"),
      email: str("PASSKIT_ISSUER_EMAIL"),
    },
    siteOrigin: (str("NEXT_PUBLIC_SITE_ORIGIN") || "https://www.coattail.cash").replace(/\/$/, ""),
    webServiceUrl: "",
  };
  cfg.webServiceUrl = `${cfg.siteOrigin}/api/passkit`;
  const ok =
    cfg.passTypeId && cfg.teamId && cfg.signerCert && cfg.signerKey && cfg.wwdr &&
    cfg.authSecret.length >= 32 && cfg.issuer.email && cfg.issuer.address;
  return ok ? cfg : null;
}

export const passkitConfigured = (): boolean => passkitConfig() !== null;
/** Live updates = signing configured AND somewhere to remember device registrations. */
export const passkitUpdatesConfigured = (): boolean => passkitConfigured() && kvConfigured();

export function pushSecret(): string {
  return str("PASSKIT_PUSH_SECRET") || str("RECHECK_SECRET");
}
