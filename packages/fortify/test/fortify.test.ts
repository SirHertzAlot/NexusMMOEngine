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
  DOCTRINES,
  analyze,
  applyCounter,
  applyDoctrine,
  canApply,
  fortify,
  generatePondVillage,
  moatFeasible,
  renderAscii,
  rng,
  underminable,
  wellFeasible,
} from "../src/index.js";

describe("matrix", () => {
  it("is internally consistent: counters clear real weaknesses, tactics probe real weaknesses", () => {
    const kinds = new Set(["straight-charge", "dead-ground", "undermine", "no-reserve"]);
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
    assert.equal(r.analysis.exposures.siege, 0, "well and granary end up inside the walls");
    const built = r.log.map((l) => l.counter);
    assert.ok(built.includes("bend-approach"), "the causeway gets bent");
    assert.ok(built.includes("granary") && built.includes("internal-well"), "the siege reserve gets built");
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

  it("era 1 has no towers and no wells: only the early counters exist", () => {
    const r = fortify(generatePondVillage("pond"), { budget: 60, seed: 7, era: 1 });
    assert.ok(
      r.log.every((l) => ["bend-approach", "lilia", "granary"].includes(l.counter)),
      `era-1 log: ${JSON.stringify(r.log.map((l) => l.counter))}`,
    );
    assert.equal(r.settlement.towers.length, 2, "still just the two original towers");
    assert.equal(r.settlement.stores.well, false, "internal wells are era 2");
    assert.equal(r.stopReason, "no-applicable-counter");
  });
});

describe("the Roman variation (from the Short)", () => {
  it("every fresh village is siege-bait: nothing stored inside the walls", () => {
    for (const profile of ["pond", "dry", "riverside"] as const) {
      const a = analyze(generatePondVillage(profile));
      assert.equal(a.exposures.siege, 1, profile);
      assert.ok(a.weaknesses.some((w) => w.kind === "no-reserve"), profile);
    }
  });

  it("lilia on the path break a charge the walls never touch", () => {
    const s = generatePondVillage("pond");
    const before = analyze(s).exposures.charge;
    const w = analyze(s).weaknesses.find((x) => x.kind === "straight-charge")!;
    assert.ok(canApply(s, "lilia", w));
    assert.ok(applyCounter(s, "lilia", w, rng(3)));
    assert.ok(s.obstacles.size >= 2, "stake pits dug into the approach");
    const after = analyze(s).exposures.charge;
    assert.ok(after <= before * 0.55, `${before} -> ${after}`);
  });

  it("a well needs reachable water: a deep enough table forbids it", () => {
    const s = generatePondVillage("dry");
    assert.equal(wellFeasible(s), true, "4.5 m table is diggable");
    for (const t of s.grid.tiles) if (t.terrain === "land") t.waterDepth = 9;
    assert.equal(wellFeasible(s), false);
    const w = analyze(s).weaknesses.find((x) => x.kind === "no-reserve")!;
    assert.equal(canApply(s, "internal-well", w), false);
    assert.equal(canApply(s, "granary", w), true, "the granary has no such constraint");
  });

  it("a doctrine stamps the culture's compiled answers at generation", () => {
    const s = generatePondVillage("pond");
    const chargeBefore = analyze(s).exposures.charge;
    const applied = applyDoctrine(s, DOCTRINES.roman);
    assert.deepEqual(applied, ["lilia", "granary", "internal-well"]);
    const a = analyze(s);
    assert.equal(a.exposures.siege, 0, "the Roman fort does not starve");
    assert.ok(a.exposures.charge < chargeBefore, "lilia blunt the lane before any local threat is known");
  });
});
