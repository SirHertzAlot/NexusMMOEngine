/**
 * Town structures (IX6): a building holds out against blows from anyone weaker than its
 * minStrength, breaks into a ruin that stays broken, and is mended with pouch materials
 * over a cast; a ruin survives a restart; the kinds data parses.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { addComponent, hasComponent } from "bitecs";
import { fileURLToPath } from "node:url";
import { engineDefaults } from "@mmo-engine/rules";
import { AssetRef, BodyConfig, Breakable, Health, Transform } from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import { BreakSystem, loadStructureBreakables, SqlitePlacesStore } from "../../src/interact/index.js";
import { BROKEN_VARIANT } from "@mmo-engine/protocol";

const HOUSE = { health: 300, into: "variant" as const, respawnS: null, minStrength: 14, repair: { material: "yew-log", count: 6, castSeconds: 6 } };

function world(): SimWorld {
  const rules = engineDefaults();
  rules.stats = {
    attributes: [{ id: "strength", name: "Strength", base: 10, min: 1, max: 100 }],
    stats: [],
  } as never;
  return new SimWorld({ stats: rules.stats });
}

function building(sim: SimWorld, x: number, z: number): number {
  const e = sim.spawn();
  addComponent(sim.ecs, Transform, e);
  Transform.px[e] = x;
  Transform.pz[e] = z;
  Transform.qw[e] = 1;
  addComponent(sim.ecs, AssetRef, e);
  AssetRef.assetHash[e] = 5;
  addComponent(sim.ecs, BodyConfig, e);
  BodyConfig.halfX[e] = 4;
  BodyConfig.halfY[e] = 3;
  BodyConfig.halfZ[e] = 3;
  return e;
}

function person(sim: SimWorld, x: number, z: number, strength: number): number {
  const e = sim.spawn();
  addComponent(sim.ecs, Transform, e);
  Transform.px[e] = x;
  Transform.pz[e] = z;
  sim.stats.attach(e, { strength });
  return e;
}

function pouchOf(initial: Record<string, number>) {
  const pouch = new Map(Object.entries(initial));
  return {
    pouch,
    materials: {
      count: (_h: number, m: string) => pouch.get(m) ?? 0,
      spend: (_h: number, m: string, n: number) => ((pouch.get(m) ?? 0) >= n ? (pouch.set(m, pouch.get(m)! - n), true) : false),
    },
  };
}

describe("buildings", () => {
  it("hold out against the weak, creatures and the unstatted pass", () => {
    const sim = world();
    const breaks = new BreakSystem(new Map(), {});
    const house = building(sim, 0, 0);
    breaks.register(sim, house, "t/house", HOUSE);
    assert.equal(breaks.canHit(sim, person(sim, 9, 0, 8), house), false, "strength 8 < 14");
    assert.equal(breaks.canHit(sim, person(sim, 9, 0, 14), house), true);
    const wolf = sim.spawn(); // no stats: a creature
    assert.equal(breaks.canHit(sim, wolf, house), true);
    assert.equal(breaks.canHit(sim, person(sim, 9, 0, 1), sim.spawn()), true, "an ordinary target has no gate");
  });

  it("break into a ruin that stays broken, and are mended with materials over a cast", () => {
    const sim = world();
    const { pouch, materials } = pouchOf({ "yew-log": 5 });
    const breaks = new BreakSystem(new Map(), { materials });
    const house = building(sim, 0, 0);
    breaks.register(sim, house, "t/house", HOUSE);
    assert.equal(hasComponent(sim.ecs, Breakable, house), true);
    Health.current[house] = 0;
    breaks.step(sim);
    assert.equal(AssetRef.variant[house], BROKEN_VARIANT);
    assert.equal(hasComponent(sim.ecs, BodyConfig, house), false);
    assert.equal(breaks.hasRuin(house), true);
    assert.deepEqual(breaks.views(sim).map((v) => [v.kind, v.open]), [["ruin", false]]);
    breaks.step(sim);
    breaks.step(sim);
    assert.equal(breaks.hasRuin(house), true, "no timer: still broken");

    const mender = person(sim, 9, 0, 10); // 5 m from the wall's edge at 4: too far for 3
    assert.deepEqual(breaks.checkRepair(1, mender, house), { ok: false, error: "too far away" });
    Transform.px[mender] = 6; // 2 m from the edge
    assert.deepEqual(breaks.checkRepair(1, mender, house), { ok: false, error: "mending it takes 6 yew-log" });
    pouch.set("yew-log", 6);
    assert.deepEqual(breaks.checkRepair(1, mender, house), { ok: true, castSeconds: 6, spell: "repair" });
    assert.equal(pouch.get("yew-log"), 6, "checking costs nothing");
    breaks.drainChanges(sim);
    assert.deepEqual(breaks.repair(sim, 1, mender, house), { ok: true });
    assert.equal(pouch.get("yew-log"), 0, "spent");
    assert.deepEqual([hasComponent(sim.ecs, BodyConfig, house), hasComponent(sim.ecs, Breakable, house), AssetRef.variant[house], Health.current[house]], [true, true, 0, 300]);
    assert.deepEqual(breaks.drainChanges(sim).map((v) => [v.kind, v.open]), [["ruin", true]], "no longer a target");
    assert.deepEqual(breaks.repair(sim, 1, mender, house), { ok: false, error: "nothing to repair there" });
  });

  it("stay ruins across a restart until mended", () => {
    const store = new SqlitePlacesStore(new Database(":memory:"));
    const { materials } = pouchOf({ "yew-log": 6 });
    const sim1 = world();
    const b1 = new BreakSystem(new Map(), { store, materials });
    const h1 = building(sim1, 0, 0);
    b1.register(sim1, h1, "t/house", HOUSE);
    Health.current[h1] = 0;
    b1.step(sim1);
    assert.equal(store.load("break", "t/house")?.respawnAt, null);

    const sim2 = world();
    const b2 = new BreakSystem(new Map(), { store, materials });
    const h2 = building(sim2, 0, 0);
    b2.register(sim2, h2, "t/house", HOUSE);
    assert.equal(b2.hasRuin(h2), true, "a ruin again at once");
    assert.equal(hasComponent(sim2.ecs, BodyConfig, h2), false);
    const mender = person(sim2, 6, 0, 10);
    assert.equal(b2.repair(sim2, 1, mender, h2).ok, true);
    assert.equal(store.load("break", "t/house"), undefined, "the record is cleared");
  });
});

describe("content/structures.json", () => {
  it("parses, and every kind is a building that stays broken until mended", () => {
    const kinds = loadStructureBreakables(fileURLToPath(new URL("../../../../../content/structures.json", import.meta.url)));
    assert.ok(kinds.size > 20);
    for (const [kind, def] of kinds) {
      assert.equal(def.into, "variant", kind);
      assert.equal(def.respawnS, null, kind);
      assert.ok(def.repair && def.minStrength, kind);
    }
    assert.ok(kinds.has("farmhouse"));
  });
});
