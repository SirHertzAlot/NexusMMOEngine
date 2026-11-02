/**
 * Raid species in the wildlife table (WL2): the table's raiders are sound, map to
 * creature raid rules, and a real raider from the content goes for a settlement once hungry.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CreaturesSchema } from "@mmo-engine/rules";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { CreatureSystem, type RaidSettlement } from "../src/creatures.js";
import { loadGameRules } from "../src/rules/boot.js";
import { checkWildlife, loadWildlifeTable, SpeciesSchema } from "../src/procgen/wildlife-table.js";
import { loadNaturalWeapons, wildlifeCreatures } from "../src/procgen/wildlife-creatures.js";

const game = loadGameRules();
const table = loadWildlifeTable();
const creatures = wildlifeCreatures(table, loadNaturalWeapons());

describe("raid species", () => {
  it("the table's raiders are sound and map to creature raid rules; others do not raid", () => {
    assert.deepEqual(checkWildlife(table), []);
    for (const id of ["coyote", "raccoon"]) {
      assert.equal(table.species[id]!.temperament, "raid", `${id} is a raider`);
      assert.ok(creatures[id]!.behavior?.raid, `${id} maps to a raid rule`);
    }
    assert.equal(creatures.deer!.behavior?.raid, undefined);
  });

  it("a raider needs a raid block, a raid block needs raid temperament", () => {
    const deer = table.species.deer!;
    assert.throws(() => SpeciesSchema.parse({ ...deer, temperament: "raid" }), /raid block/);
    assert.throws(() => SpeciesSchema.parse({ ...deer, raid: { rangeM: 100 } }), /raid block/);
    assert.doesNotThrow(() => SpeciesSchema.parse({ ...deer, temperament: "raid", raid: { rangeM: 100 } }));
  });

  it("a hungry coyote from the content goes for a settlement in range", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const settlements: RaidSettlement[] = [{ x: 0, z: 300, size: 10, radius: 30 }];
    const sys = new CreatureSystem({
      creatures: CreaturesSchema.parse({ creatures: { coyote: creatures.coyote } }).creatures,
      bases: game.rules.items.bases,
      timeOfDay: () => null,
      steer: false,
      settlements: () => settlements,
    });
    const [c] = sys.spawnPack(sim, "coyote", 0, 0, [1, 1]);
    let tick = 0;
    let raided = false;
    for (let i = 0; i < 20000 && !raided; i++) {
      sim.beginTick(++tick);
      sys.step(sim);
      for (const e of sys.entities()) {
        C.Transform.px[e] += C.PlayerIntent.mx[e] * 0.1;
        C.Transform.pz[e] += C.PlayerIntent.mz[e] * 0.1;
      }
      sim.endTick();
      raided = sys.modeOf(c!) === "raid";
    }
    assert.ok(raided, "the coyote got hungry and set out to raid");
    assert.equal(sys.raids().length, 1, "it is raiding the settlement in range");
  });
});
