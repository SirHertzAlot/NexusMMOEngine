/**
 * Stats: our game's attributes and derived stats load and start at their
 * "normal" values; modifiers add, sum percentages and compound
 * multipliers; attribute changes flow into the stats that read them;
 * bounds clamp; bad stats files are reported by file and field.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  computeStats,
  engineDefaults,
  loadRules,
  ModifierTotals,
  parseRules,
  RulesError,
  StatLayout,
} from "../src/index.js";

const OUR_RULES = fileURLToPath(new URL("../../../../content/rules", import.meta.url));

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof RulesError) return e.issues.map((i) => `${i.file}${i.path ? `: ${i.path}` : ""}: ${i.message}`);
    throw e;
  }
  assert.fail("expected a RulesError");
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

describe("our game's stats (content/rules/stats.json)", () => {
  const layout = new StatLayout(loadRules(OUR_RULES).stats);
  const value = (vals: Float64Array, id: string): number => vals[layout.index.get(id)!];

  it("have attributes and derived stats, attributes first", () => {
    assert.deepEqual(layout.ids.slice(0, layout.attributeCount), ["strength", "agility", "vitality", "intellect", "willpower"]);
    assert.ok(layout.size > layout.attributeCount, "and derived stats after them");
    assert.equal(layout.ids[layout.drives.get("moveSpeed")!], "moveSpeed");
    assert.equal(layout.ids[layout.drives.get("maxHealth")!], "maxHealth");
  });

  it("start at today's numbers: 100 health, normal speed, ×1 power", () => {
    const v = computeStats(layout, layout.bases, null);
    assert.ok(near(value(v, "maxHealth"), 100));
    assert.ok(near(value(v, "moveSpeed"), 1));
    assert.ok(near(value(v, "attackSpeed"), 1));
    assert.ok(near(value(v, "power"), 1));
  });

  it("carry an attribute buff into every stat that reads it", () => {
    const totals = new ModifierTotals(layout.size);
    totals.apply(layout.index.get("vitality")!, "add", 4);
    const v = computeStats(layout, layout.bases, totals);
    assert.equal(value(v, "vitality"), 14);
    assert.ok(near(value(v, "maxHealth"), 120), `${value(v, "maxHealth")}`);
    assert.ok(near(value(v, "power"), 1), "strength untouched");
  });

  it("cap movement speed at twice normal however much haste stacks", () => {
    const totals = new ModifierTotals(layout.size);
    for (let i = 0; i < 10; i++) totals.apply(layout.index.get("moveSpeed")!, "percent", 0.5);
    assert.equal(value(computeStats(layout, layout.bases, totals), "moveSpeed"), 2);
  });
});

describe("stat arithmetic", () => {
  const layout = new StatLayout(
    parseRules({
      stats: {
        attributes: [{ id: "str", name: "Strength", base: 10 }],
        stats: [{ id: "power", name: "Power", base: 1, from: { str: 0.5 } }],
      },
    }).stats,
  );
  const P = layout.index.get("power")!;
  const S = layout.index.get("str")!;

  it("adds, then sums percentages, then compounds multipliers", () => {
    const t = new ModifierTotals(layout.size);
    t.apply(P, "add", 4); // 1 + 10×0.5 + 4 = 10
    t.apply(P, "percent", 0.1);
    t.apply(P, "percent", 0.2); // ×1.3 (summed, not 1.1×1.2)
    t.apply(P, "multiply", 0.5);
    t.apply(P, "multiply", 0.5); // ×0.25 (compounded)
    assert.ok(near(computeStats(layout, layout.bases, t)[P], 10 * 1.3 * 0.25));
  });

  it("reads attributes after their own modifiers", () => {
    const t = new ModifierTotals(layout.size);
    t.apply(S, "multiply", 2); // strength 20
    assert.ok(near(computeStats(layout, layout.bases, t)[P], 1 + 20 * 0.5));
  });

  it("uses per-entity bases (a troll's), and resets cleanly", () => {
    const bases = Float64Array.from(layout.bases);
    bases[S] = 30;
    const t = new ModifierTotals(layout.size);
    t.apply(P, "add", 100);
    t.reset();
    assert.ok(near(computeStats(layout, bases, t)[P], 16));
  });
});

describe("stats files", () => {
  it("are optional: the engine default has no stats at all", () => {
    const d = engineDefaults();
    assert.deepEqual(d.stats, { attributes: [], stats: [] });
    assert.equal(new StatLayout(d.stats).size, 0);
  });

  it("allow derived stats alone, or attributes alone", () => {
    parseRules({ stats: { stats: [{ id: "moveSpeed", name: "Speed", base: 1, drives: "moveSpeed" }] } });
    parseRules({ stats: { attributes: [{ id: "might", name: "Might", drives: "maxHealth" }] } });
  });

  it("report bad stats by field: reused ids, unknown attributes, a drive bound twice, bounds", () => {
    const issues = issuesOf(() =>
      parseRules({
        stats: {
          attributes: [
            { id: "str", name: "Strength", base: 0, min: 1 },
            { id: "agi", name: "Agility", min: 5, max: 1 },
          ],
          stats: [
            { id: "str", name: "Also strength" },
            { id: "speed", name: "Speed", from: { dex: 1 }, drives: "moveSpeed" },
            { id: "haste", name: "Haste", drives: "moveSpeed" },
          ],
        },
      }),
    );
    const has = (prefix: string): boolean => issues.some((i) => i.startsWith(prefix));
    assert.ok(has("stats.json: attributes[0].base:"), issues.join("\n"));
    assert.ok(has("stats.json: attributes[1].min:"), issues.join("\n"));
    assert.ok(has("stats.json: stats[0].id:"), "attributes and stats share one id space");
    assert.ok(has("stats.json: stats[1].from.dex:"), issues.join("\n"));
    assert.ok(has("stats.json: stats[2].drives:"), issues.join("\n"));
  });

  it("reject an unknown drive and a misspelt field", () => {
    const issues = issuesOf(() => parseRules({ stats: { stats: [{ id: "x", name: "X", drives: "jumpHeight" }], atributes: [] } }));
    assert.ok(issues.some((i) => i.startsWith("stats.json: stats[0].drives")), issues.join("\n"));
    assert.ok(issues.some((i) => /atributes/.test(i)), "a misspelt field is an error");
  });
});
