import deployments from "../deployments.json" with { type: "json" };

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

validateMainnetConfig();
