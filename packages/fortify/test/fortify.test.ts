/**
 * The fortify prototype: matrix sanity, the attack sim's three probes on
 * the pond-village fixture, and the loop's behaviour — determinism,
 * era gating, budget exhaustion, and the counters doing what the matrix
 * claims they do.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MATRIX,
  analyze,
  applyCounter,
  canApply,
  fortify,
  generatePondVillage,
  moatFeasible,
  renderAscii,
  rng,
  underminable,
} from "../src/index.js";

describe("matrix", () => {
  it("is internally consistent: counters clear real weaknesses, tactics probe real weaknesses", () => {
    const kinds = new Set(["straight-charge", "dead-ground", "undermine"]);
    for (const c of DEFAULT_MATRIX.counters) {
      assert.ok(kinds.has(c.clears), `${c.id} clears unknown kind ${c.clears}`);
      assert.ok(c.cost > 0, `${c.id} must cost something`);
      assert.ok(c.era >= 1);
    }
    for (const t of DEFAULT_MATRIX.tactics) assert.ok(kinds.has(t.probes));
    const ids = DEFAULT_MATRIX.counters.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, "counter ids unique");
  });
});

describe("generator + attack sim", () => {
  it("the pond village as generated has a straight charge lane and dead ground", () => {
    const s = generatePondVillage("pond");
    const a = analyze(s);
    assert.ok(a.approach.path, "approach exists");
    assert.ok(a.approach.finalStraight >= 5, `final straight ${a.approach.finalStraight}`);
    assert.ok(a.exposures.charge > 0.5, `charge exposure ${a.exposures.charge}`);
    assert.ok(a.exposures.ladders > 0, "some face is dead ground");
    assert.ok(a.weaknesses.some((w) => w.kind === "straight-charge"));
    assert.ok(a.weaknesses.some((w) => w.kind === "dead-ground"));
  });

  it("pond terrain defeats mining outright: every sap floods", () => {
    const a = analyze(generatePondVillage("pond"));
    assert.equal(a.exposures.mining, 0);
    assert.ok(!a.weaknesses.some((w) => w.kind === "undermine"));
  });

  it("dry terrain makes mining live, on towers and gate alike", () => {
    const s = generatePondVillage("dry");
    const a = analyze(s);
    assert.ok(a.exposures.mining > 0);
    assert.ok(a.weaknesses.filter((w) => w.kind === "undermine").length >= 3);
    assert.ok(underminable(s, 5, 5), "NW tower sappable");
  });

  it("moat feasibility follows the water: dry no, riverside west yes", () => {
    const dry = generatePondVillage("dry");
    assert.equal(moatFeasible(dry, 5, 5), false);
    const river = generatePondVillage("riverside");
    assert.equal(moatFeasible(river, 5, 5), true, "NW tower is within diversion distance of the river");
    assert.equal(moatFeasible(river, 12, 19), false, "the gate is too far from the water");
  });
});

describe("counters", () => {
  it("bending the approach collapses the charge lane", () => {
    const s = generatePondVillage("pond");
    const before = analyze(s).exposures.charge;
    const w = analyze(s).weaknesses.find((x) => x.kind === "straight-charge")!;
    assert.ok(canApply(s, "bend-approach", w));
    assert.ok(applyCounter(s, "bend-approach", w, rng(3)));
    const after = analyze(s);
    assert.ok(after.exposures.charge < before, `${before} -> ${after.exposures.charge}`);
    assert.ok(after.approach.turns >= 2, "the new approach turns");
  });

  it("a barbican blunts a straight approach it cannot bend", () => {
    const s = generatePondVillage("pond");
    const before = analyze(s).exposures.charge;
    const w = analyze(s).weaknesses.find((x) => x.kind === "straight-charge")!;
    assert.ok(applyCounter(s, "barbican", w, rng(3)));
    const after = analyze(s).exposures.charge;
    assert.ok(after <= before * 0.4, `${before} -> ${after}`);
  });

  it("a moat dug around a tower ends its undermining", () => {
    const s = generatePondVillage("riverside");
    assert.ok(underminable(s, 5, 5));
    const w = analyze(s).weaknesses.find((x) => x.kind === "undermine" && x.site.kind === "structure" && x.site.x === 5)!;
    assert.ok(canApply(s, "moat", w));
    assert.ok(applyCounter(s, "moat", w, rng(3)));
    assert.equal(underminable(s, 5, 5), false);
  });
});

describe("fortify loop", () => {
  it("is deterministic per seed: same inputs, same build log, same town", () => {
    const a = fortify(generatePondVillage("dry"), { budget: 60, seed: 7 });
    const b = fortify(generatePondVillage("dry"), { budget: 60, seed: 7 });
    assert.deepEqual(a.log, b.log);
    assert.equal(renderAscii(a.settlement), renderAscii(b.settlement));
  });

  it("does not mutate its input", () => {
    const s = generatePondVillage("pond");
    const before = renderAscii(s);
    fortify(s, { budget: 40, seed: 7 });
    assert.equal(renderAscii(s), before);
  });

  it("fortifies the pond village within a 40-point budget", () => {
    const r = fortify(generatePondVillage("pond"), { budget: 40, seed: 7 });
    assert.equal(r.stopReason, "threshold-met");
    assert.ok(r.log.length >= 3, `log: ${JSON.stringify(r.log.map((l) => l.counter))}`);
    assert.ok(r.spent <= 40);
    assert.ok(r.analysis.exposures.charge <= 0.25);
    assert.equal(r.analysis.exposures.ladders, 0);
    // The first build answers the worst weakness (the charge lane).
    assert.equal(r.log[0].counter, "bend-approach");
  });

  it("rounds the dry village's towers; the gate stays its honest weak point", () => {
    const r = fortify(generatePondVillage("dry"), { budget: 90, seed: 7 });
    assert.ok(r.settlement.towers.every((t) => t.form === "round"), "every tower rebuilt round");
    assert.ok(r.log.some((l) => l.counter === "round-tower"));
    // No counter in the matrix saves a dry-soil gate: the loop must say
    // so, not paper over it.
    assert.ok(r.analysis.weaknesses.some((w) => w.kind === "undermine"));
    assert.equal(r.stopReason, "no-applicable-counter");
  });

  it("stops on budget, and says so", () => {
    const r = fortify(generatePondVillage("pond"), { budget: 1, seed: 7 });
    assert.equal(r.stopReason, "budget-exhausted");
    assert.equal(r.log.length, 0);
  });

  it("era 1 has only the bend: no towers rise before their time", () => {
    const r = fortify(generatePondVillage("pond"), { budget: 60, seed: 7, era: 1 });
    assert.ok(r.log.every((l) => l.counter === "bend-approach"));
    assert.equal(r.settlement.towers.length, 2, "still just the two original towers");
    assert.equal(r.stopReason, "no-applicable-counter");
  });
});
