// The marks pair begin with end (outside valgrind they do nothing else).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const probe = createRequire(import.meta.url)("../index.js");

describe("addon-perf-probe", () => {
  it("says whether it runs under valgrind, and pairs begin with end", () => {
    assert.equal(typeof probe.running(), "boolean");
    probe.begin();
    assert.throws(() => probe.begin(), /twice/);
    probe.end("x");
    assert.throws(() => probe.end("x"), /without begin/);
  });
});
