import test from "node:test";
import assert from "node:assert/strict";
import { logWindows, readLogWindows, MAX_LOG_SPAN } from "../src/lib/logRange.ts";

test("windows cover the range exactly, none wider than the RPC cap", () => {
  const from = 39460869n, to = 89379630n; // the Broker deployment block to a mid-October head
  const w = logWindows(from, to);
  assert.equal(w[0][0], from);
  assert.equal(w.at(-1)[1], to);
  for (let i = 0; i < w.length; i++) {
    assert.ok(w[i][1] - w[i][0] + 1n <= MAX_LOG_SPAN);
    assert.ok(MAX_LOG_SPAN < 10_000_000n);
    if (i > 0) assert.equal(w[i][0], w[i - 1][1] + 1n, "no gap, no overlap");
  }
  assert.deepEqual(logWindows(5n, 5n), [[5n, 5n]]);
  assert.deepEqual(logWindows(10n, 9n), []);
});

test("readLogWindows concatenates in order", async () => {
  const out = await readLogWindows(0n, 25n, async (a, b) => [`${a}-${b}`], );
  assert.deepEqual(out, ["0-25"]);
  const many = await readLogWindows(1n, 3n * MAX_LOG_SPAN, async (a) => [a]);
  assert.deepEqual(many, [1n, 1n + MAX_LOG_SPAN, 1n + 2n * MAX_LOG_SPAN]);
});
