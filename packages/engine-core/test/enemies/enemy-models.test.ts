/** EM1: enemy kinds' art models come from data; a kind with none keeps its stand-in block. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enemyModelPicker, parseEnemyModels } from "../../src/enemy-models.js";

describe("enemy models", () => {
  it("maps a kind to one id or a list of ids, and reports the bad entries without failing", () => {
    const warnings: string[] = [];
    const models = parseEnemyModels(
      { goblin: "catalog/goblin", skeleton: ["catalog/skel-a", "catalog/skel-b"], bad: 3, empty: [], ghost: "x" },
      (m) => warnings.push(m),
      (kind) => kind !== "ghost",
    );
    assert.deepEqual(models, { goblin: ["catalog/goblin"], skeleton: ["catalog/skel-a", "catalog/skel-b"], ghost: ["x"] });
    assert.equal(warnings.length, 3, warnings.join("\n"));
    assert.ok(warnings.some((w) => w.includes("bad needs")));
    assert.ok(warnings.some((w) => w.includes("empty needs")));
    assert.ok(warnings.some((w) => w.includes("ghost is not a creature kind")));
  });

  it("refuses a file that is not an object of kinds, and gives no models", () => {
    const warnings: string[] = [];
    assert.deepEqual(parseEnemyModels(["goblin"], (m) => warnings.push(m)), {});
    assert.equal(warnings.length, 1);
  });

  it("picks a kind's ids in turn, and gives undefined for a kind with none", () => {
    const pick = enemyModelPicker({ skeleton: ["a", "b"] });
    assert.deepEqual([pick("skeleton"), pick("skeleton"), pick("skeleton"), pick("goblin")], ["a", "b", "a", undefined]);
  });
});
