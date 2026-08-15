import test from "node:test";
import assert from "node:assert/strict";
import { validateMainnetConfig } from "../scripts/validate-config.mjs";

test("testnet build permits its configured deployment", () => {
  assert.doesNotThrow(() => validateMainnetConfig({ NEXT_PUBLIC_NETWORK: "testnet" }, {}));
});

test("mainnet build rejects placeholders", () => {
  assert.throws(() => validateMainnetConfig({ NEXT_PUBLIC_NETWORK: "mainnet" }, {
    broker: "0x0000000000000000000000000000000000000000", router: "", poolId: "0x"
  }), /empty or zero/);
});
