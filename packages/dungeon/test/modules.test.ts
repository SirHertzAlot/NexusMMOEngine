import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateDungeon,
  BUILTIN_THEMES,
  propagateDungeonModules,
} from "../src/index.js";

describe("propagateDungeonModules: 3D Grid WFC", () => {
  it("propagates 3D module variations from a dungeon layout", () => {
    const dungeon = generateDungeon(
      { seed: 101, rooms: 12, loopChance: 0.2, decorDensity: 0.5, theme: "ancient" },
      BUILTIN_THEMES["ancient"],
    );

    const { result, activeInstances, stats } = propagateDungeonModules(dungeon, {
      seed: 101,
      depth: 2,
    });

    assert.ok(stats.totalPlaced > 0, "should place active module instances");
    assert.ok(stats.floors > 0, "should place floor modules");
    assert.ok(stats.ceilings > 0, "should place ceiling modules");

    // All active instances must be within bounds and have valid rotations
    for (const inst of activeInstances) {
      assert.ok(inst.x >= 0 && inst.x < dungeon.width);
      assert.ok(inst.y >= 0 && inst.y < dungeon.height);
      assert.ok(inst.z >= 0 && inst.z < 2);
      assert.ok([0, 90, 180, 270].includes(inst.rot));
      assert.ok(inst.modelId && inst.modelId.startsWith("dungeon-pack/"));
    }

    // Verify determinism
    const secondRun = propagateDungeonModules(dungeon, { seed: 101, depth: 2 });
    assert.equal(activeInstances.length, secondRun.activeInstances.length);
    for (let i = 0; i < activeInstances.length; i++) {
      assert.equal(activeInstances[i].variationId, secondRun.activeInstances[i].variationId);
      assert.equal(activeInstances[i].rot, secondRun.activeInstances[i].rot);
    }
  });
});
