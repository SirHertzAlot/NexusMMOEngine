/** MasterySystem (M1): swimming and running train their skills. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { LocomotionMode } from "@mmo-engine/protocol";
import { fileURLToPath } from "node:url";
import { loadRules } from "@mmo-engine/rules";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { MasterySystem } from "../src/stats/mastery-system.js";

const DT = 1 / 30;
const skills = loadRules(fileURLToPath(new URL("../../../../content/rules", import.meta.url))).skills;

function setup(): { sim: SimWorld; e: number; sys: MasterySystem; run(seconds: number): void } {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const e = sim.spawn();
  for (const c of [C.Health, C.PlayerIntent, C.Locomotion]) {
    addComponent(sim.ecs, c, e);
    for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[e] = 0;
  }
  C.Health.current[e] = C.Health.max[e] = 100;
  const sys = new MasterySystem(skills, () => 1000);
  let tick = 0;
  return {
    sim, e, sys,
    run(seconds) {
      for (let i = 0; i < Math.round(seconds / DT); i++) {
        sim.beginTick(++tick);
        sys.step(sim, DT);
        sim.endTick();
      }
    },
  };
}

describe("MasterySystem", () => {
  it("standing still trains nothing", () => {
    const { e, sys, run } = setup();
    run(60);
    assert.equal(sys.sheetOf(e).get("athletics"), 0);
  });

  it("running trains athletics, not swimming", () => {
    const { e, sys, run } = setup();
    C.PlayerIntent.mx[e] = 1;
    run(60);
    assert.ok(sys.sheetOf(e).get("athletics") > 0);
    assert.equal(sys.sheetOf(e).get("swimming"), 0);
  });

  it("swimming trains swimming", () => {
    const { e, sys, run } = setup();
    C.Locomotion.mode[e] = LocomotionMode.Swim;
    C.PlayerIntent.mz[e] = 1;
    run(60);
    assert.ok(sys.sheetOf(e).get("swimming") > 0);
  });

  it("the dead and forgotten train nothing", () => {
    const { e, sys, run } = setup();
    C.PlayerIntent.mx[e] = 1;
    C.Health.current[e] = 0;
    run(60);
    assert.equal(sys.sheetOf(e).get("athletics"), 0);
    sys.forget(e);
    assert.equal(sys.sheetOf(e).get("athletics"), 0);
  });
});

describe("disciplines and familiarity (M4)", () => {
  const all = loadRules(fileURLToPath(new URL("../../../../content/rules", import.meta.url)));
  const blade = all.disciplines.disciplines.find((d) => d.id === "bladeMaster")!;
  const make = () => {
    const sys = new MasterySystem(all.skills, () => 1000, all.disciplines.disciplines);
    const sheet = sys.sheetOf(7);
    const set = (id: string, value: number, peak = value): void => {
      const i = sys.index.of(id);
      sheet.value[i] = value;
      sheet.peak[i] = peak;
    };
    return { sys, sheet, set };
  };

  it("earns a discipline when every skill it needs is at its level", () => {
    const { sys, set } = make();
    assert.deepEqual(sys.disciplinesOf(7), []);
    for (const [id, level] of Object.entries(blade.requires)) set(id, level - 1);
    assert.deepEqual(sys.disciplinesOf(7), []);
    assert.equal(sys.knows(7, "disarm"), false);
    for (const [id, level] of Object.entries(blade.requires)) set(id, level);
    assert.deepEqual(sys.disciplinesOf(7), [{ id: "bladeMaster", name: blade.name, active: true, unlocks: blade.unlocks }]);
    assert.equal(sys.knows(7, "disarm"), true);
    assert.equal(sys.knows(7, "sweep"), false);
    assert.equal(sys.knows(8, "disarm"), false, "nobody else");
  });

  it("keeps the title after the skills decay, but not its technique", () => {
    const { sys, set } = make();
    for (const [id, level] of Object.entries(blade.requires)) set(id, level - 10, level);
    assert.deepEqual(sys.disciplinesOf(7).map((d) => [d.id, d.active]), [["bladeMaster", false]]);
    assert.equal(sys.knows(7, "disarm"), false);
  });

  it("familiarity grows with use, up to 1, and is saved with the skills", () => {
    const { sys, sheet } = make();
    const per = all.skills.familiarity.perUse;
    assert.equal(sheet.familiarity("sword"), 0);
    sheet.useFamily("sword", 1000);
    sheet.useFamily("sword", 1000);
    assert.ok(Math.abs(sheet.familiarity("sword") - 2 * per) < 1e-9);
    for (let i = 0; i < Math.ceil(1 / per) + 5; i++) sheet.useFamily("axe", 2000);
    assert.equal(sheet.familiarity("axe"), 1);
    const saved = sheet.save();
    assert.deepEqual(saved["fam:axe"], [1000, 1000, 2000]);
    const back = new MasterySystem(all.skills, () => 1000).sheetOf(1);
    back.load(saved);
    assert.equal(back.familiarity("axe"), 1);
    assert.ok(Math.abs(back.familiarity("sword") - 2 * per) < 1e-3);
    assert.deepEqual(back.families().map(([f]) => f).sort(), ["axe", "sword"]);
    void sys;
  });
});
