import deployments from "../deployments.json" with { type: "json" };

// Defence in depth for "no blockchain private key belongs in the Vercel frontend":
// fail the build if any browser-exposed NEXT_PUBLIC_* variable looks like a secret.
export function assertNoLeakedSecrets(env = process.env) {
  const privateKey = /^0x[0-9a-f]{64}$/i;
  const secretName = /(PRIVATE_KEY|MNEMONIC|SECRET|SEED_PHRASE)/i;
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("NEXT_PUBLIC_")) continue;
    if (secretName.test(key) || (typeof value === "string" && privateKey.test(value.trim()))) {
      throw new Error(`Refusing to build: browser-exposed '${key}' looks like a private key or secret`);
    }
  }
}

export function validateMainnetConfig(env = process.env, config = deployments.mainnet) {
  if ((env.NEXT_PUBLIC_NETWORK ?? "testnet") !== "mainnet") return;
  const zeroAddress = /^0x0{40}$/i;
  const zeroHash = /^0x0{64}$/i;
  for (const [key, value] of Object.entries(config)) {
    if (!value || zeroAddress.test(value) || zeroHash.test(value)) {
      throw new Error(`Mainnet config '${key}' is empty or zero`);
    }
  }
  if (!env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID) {
    throw new Error("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is required for mainnet");
  }
  if (!env.NEXT_PUBLIC_RPC_URL_MAINNET) {
    throw new Error("NEXT_PUBLIC_RPC_URL_MAINNET is required for mainnet");
  }
}

assertNoLeakedSecrets();
validateMainnetConfig();
