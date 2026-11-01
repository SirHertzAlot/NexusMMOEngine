/** SG4b: the Bake button runs one bake at a time, keeps its output, and Cancel stops it. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SettlementBake } from "../src/settlement-bake.js";

const node = (script: string) => () => ({ command: process.execPath, args: ["-e", script], shell: false });
const wait = async (until: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!until() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

describe("SettlementBake", () => {
  it("runs the bake, keeps its output and reports done on exit 0", async () => {
    const bake = new SettlementBake(node("console.log('towns: 3'); process.exit(0)"), process.cwd());
    assert.equal(bake.current().state, "idle");
    bake.start();
    await wait(() => bake.current().state !== "running");
    const s = bake.current();
    assert.equal(s.state, "done");
    assert.equal(s.exitCode, 0);
    assert.match(s.log, /towns: 3/);
  });

  it("reports failed on a non-zero exit, with the output", async () => {
    const bake = new SettlementBake(node("console.error('no rules'); process.exit(2)"), process.cwd());
    bake.start();
    await wait(() => bake.current().state !== "running");
    assert.equal(bake.current().state, "failed");
    assert.equal(bake.current().exitCode, 2);
    assert.match(bake.current().log, /no rules/);
  });

  it("refuses a second bake while one runs, and a cancel when none runs", async () => {
    const bake = new SettlementBake(node("setTimeout(() => {}, 60000)"), process.cwd());
    assert.throws(() => bake.cancel(), (e: Error & { status?: number }) => e.status === 409);
    bake.start();
    assert.throws(() => bake.start(), (e: Error & { status?: number }) => e.status === 409);
    bake.cancel();
    await wait(() => bake.current().state !== "running");
    assert.equal(bake.current().state, "cancelled");
  });

  it("keeps only the tail of a long output", async () => {
    const bake = new SettlementBake(node("process.stdout.write('x'.repeat(200000) + 'END')"), process.cwd());
    bake.start();
    await wait(() => bake.current().state !== "running");
    assert.ok(bake.current().log.length <= 64_000);
    assert.ok(bake.current().log.endsWith("END"));
  });
});
