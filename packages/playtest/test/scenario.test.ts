/**
 * TDD: EA26 automated playtests — scenario documents, headless runner,
 * assertions, and failure replays.
 *
 * A scenario is data: seed + ticks + bots + assertions. The runner drives
 * a SimWorld tick by tick (no sockets, no rendering) and evaluates the
 * assertions. A failing scenario saves a replay (scenario + seed) that
 * reproduces the failure tick for tick.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadScenario } from "../src/scenario.js";
import { runScenario } from "../src/runner.js";
import { saveReplay, loadReplay, firstDivergence } from "../src/replay.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCENARIO = {
  name: "sparring-check",
  seed: 12345,
  ticks: 300,
  bots: { count: 4, home: { x: 0, z: 0 }, radius: 8 },
  assertions: [
    { type: "botCount", equals: 4 },
    { type: "allBotsMoved" },
  ],
};

describe("loadScenario", () => {
  it("loads a valid scenario", () => {
    const s = loadScenario(SCENARIO);
    assert.equal(s.name, "sparring-check");
    assert.equal(s.ticks, 300);
  });

  it("rejects a scenario with no assertions", () => {
    assert.throws(() => loadScenario({ ...SCENARIO, assertions: [] }), /assertions/);
  });

  it("rejects an unknown assertion type", () => {
    assert.throws(
      () => loadScenario({ ...SCENARIO, assertions: [{ type: "nope" }] }),
      /unknown assertion/,
    );
  });

  it("rejects a negative tick count", () => {
    assert.throws(() => loadScenario({ ...SCENARIO, ticks: -1 }), /ticks/);
  });

  it("defaults the seed (deterministic default)", () => {
    const { seed, ...rest } = SCENARIO;
    const s = loadScenario(rest);
    assert.equal(typeof s.seed, "number");
    assert.equal(loadScenario(rest).seed, s.seed, "default seed is stable");
  });
});

describe("runScenario", () => {
  it("passes when bots spawn and move", async () => {
    const result = await runScenario(loadScenario(SCENARIO));
    assert.equal(result.passed, true);
    assert.equal(result.failures.length, 0);
    assert.equal(result.ticks, 300);
  });

  it("fails honestly when the assertion is wrong", async () => {
    const bad = loadScenario({ ...SCENARIO, assertions: [{ type: "botCount", equals: 99 }] });
    const result = await runScenario(bad);
    assert.equal(result.passed, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /botCount/);
  });

  it("is deterministic: same seed, same result", async () => {
    const a = await runScenario(loadScenario(SCENARIO));
    const b = await runScenario(loadScenario(SCENARIO));
    assert.equal(a.passed, b.passed);
    assert.equal(a.ticks, b.ticks);
  });
});

describe("trace and divergence (editor Playtests panel)", () => {
  it("records one bot-centroid point per tick, identical for the same seed", async () => {
    const a = await runScenario(loadScenario(SCENARIO));
    const b = await runScenario(loadScenario(SCENARIO));
    assert.equal(a.trace.length, 300);
    assert.deepEqual(a.trace, b.trace);
    assert.equal(a.trace[0]!.tick, 1);
  });

  it("firstDivergence finds the first tick two traces differ, null when equal", () => {
    const t = [1, 2, 3].map((tick) => ({ tick, x: tick, z: 0 }));
    assert.equal(firstDivergence(t, t), null);
    assert.equal(firstDivergence(t, [t[0]!, { tick: 2, x: 9, z: 0 }, t[2]!]), 2);
    assert.equal(firstDivergence(t, t.slice(0, 2)), 3, "a shorter trace diverges where it stops");
  });

  it("a replay carries its trace and the seal covers it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-"));
    try {
      const trace = [{ tick: 1, x: 0, z: 0 }];
      const file = saveReplay(dir, loadScenario(SCENARIO), { tick: 1, reason: "x" }, trace);
      assert.deepEqual(loadReplay(file).trace, trace);
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      doc.trace[0].x = 5;
      fs.writeFileSync(file, JSON.stringify(doc));
      assert.throws(() => loadReplay(file), /tamper|seal/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a description on the scenario", () => {
    assert.equal(loadScenario({ ...SCENARIO, description: "hi" }).description, "hi");
  });
});

describe("replay", () => {
  it("round-trips: save then load reproduces the scenario", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-"));
    try {
      const scenario = loadScenario(SCENARIO);
      const file = saveReplay(dir, scenario, { tick: 42, reason: "botCount failed" });
      assert.ok(fs.existsSync(file));
      const back = loadReplay(file);
      assert.equal(back.scenario.name, "sparring-check");
      assert.equal(back.scenario.seed, 12345);
      assert.equal(back.failure.tick, 42);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to load a tampered replay", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-"));
    try {
      const file = saveReplay(dir, loadScenario(SCENARIO), { tick: 1, reason: "x" });
      fs.appendFileSync(file, "tampered");
      assert.throws(() => loadReplay(file), /tamper|invalid/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
