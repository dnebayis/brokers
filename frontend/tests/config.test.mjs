import test from "node:test";
import assert from "node:assert/strict";
import { validateMainnetConfig, assertNoLeakedSecrets } from "../scripts/validate-config.mjs";

test("testnet build permits its configured deployment", () => {
  assert.doesNotThrow(() => validateMainnetConfig({ NEXT_PUBLIC_NETWORK: "testnet" }, {}));
});

test("mainnet build rejects placeholders", () => {
  assert.throws(() => validateMainnetConfig({ NEXT_PUBLIC_NETWORK: "mainnet" }, {
    broker: "0x0000000000000000000000000000000000000000", router: "", poolId: "0x"
  }), /empty or zero/);
});

test("build rejects a private key leaked into a NEXT_PUBLIC_ variable", () => {
  assert.throws(() => assertNoLeakedSecrets({
    NEXT_PUBLIC_KEEPER_PRIVATE_KEY: "0x" + "a".repeat(64)
  }), /looks like a private key/);
  assert.throws(() => assertNoLeakedSecrets({
    NEXT_PUBLIC_RPC_URL_MAINNET: "0x" + "b".repeat(64)
  }), /looks like a private key/);
});

test("build permits ordinary public config", () => {
  assert.doesNotThrow(() => assertNoLeakedSecrets({
    NEXT_PUBLIC_NETWORK: "testnet",
    NEXT_PUBLIC_RPC_URL_MAINNET: "https://rpc.mainnet.chain.robinhood.com",
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "abc123"
  }));
});
