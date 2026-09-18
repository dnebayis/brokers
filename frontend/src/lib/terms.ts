// Site terms: one version string gates the whole site. Bump it when the text changes in a
// way every visitor must see again; the one-time window then reappears for everyone.
export const TERMS_VERSION = "2026-09-18";
export const TERMS_STORAGE_KEY = "coattail.terms";

// Where the operator will not offer the stock token features. Kept as data so the list can be
// edited in one place; the terms page and the window both render it.
export const RESTRICTED_JURISDICTIONS = [
  "the United States of America, its territories and possessions, and any US person as defined in Regulation S",
  "Cuba, Iran, North Korea and Syria",
  "Russia and Belarus",
  "the Crimea, Donetsk and Luhansk regions of Ukraine",
  "any country or territory subject to comprehensive sanctions by the United Nations, the European Union, the United Kingdom or the United States",
  "any jurisdiction where holding or dealing in tokenized stock instruments, or using this interface, is unlawful or would require the operator to hold a licence or registration it does not hold",
] as const;

type Stored = { version: string; at: string };

export function readAcceptedVersion(): string | null {
  try {
    const raw = window.localStorage.getItem(TERMS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function writeAccepted(): void {
  const record: Stored = { version: TERMS_VERSION, at: new Date().toISOString() };
  try {
    window.localStorage.setItem(TERMS_STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* private mode: the acceptance lasts for this page load only */
  }
}
