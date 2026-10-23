/**
 * Gathering: a resource node's stock goes into the gatherer's pouch one at
 * a time, within reach and no faster than the cooldown; a worked-out node
 * comes back on the wall clock (never, for ore); stocks and pouches survive
 * a restart through the store; and a scene's resource nodes register as
 * they spawn (fishing spots on the water too).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import Database from "better-sqlite3";
import { Transform } from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import { GatheringSystem, nodeStocksOf, SqliteGatheringStore, materialName, type ResourceNodeSpec } from "../../src/gathering/index.js";
import { spawnScene } from "../../src/scene-spawn.js";
import { GatheringSchema } from "@mmo-engine/rules";

const HOUR = 3_600_000;
const TREES: ResourceNodeSpec = { kind: "tree_stand", material: "yew-log", tier: 2, skill: "Woodcutting", stock: 3, regrowHours: 72, halfX: 3, halfZ: 3 };
const VEIN: ResourceNodeSpec = { kind: "ore_vein", material: "silver-ore", tier: 2, skill: "Mining", stock: 2, regrowHours: 0, halfX: 1.5, halfZ: 1.25 };

function at(sim: SimWorld, x: number, z: number): number {
  const e = sim.spawn();
  addComponent(sim.ecs, Transform, e);
  Transform.px[e] = x;
  Transform.pz[e] = z;
  Transform.sx[e] = Transform.sy[e] = Transform.sz[e] = 1;
  return e;
}

function setup(store?: SqliteGatheringStore) {
  const clock = { t: 1_000_000 };
  const trained: Array<[string, number, number]> = [];
  const g = new GatheringSystem({ store, now: () => clock.t, train: (_a, skill, difficulty, key) => trained.push([skill, difficulty, key]) });
  const sim = new SimWorld();
  const tree = at(sim, 0, 0);
  const vein = at(sim, 50, 0);
  g.register(tree, "town/trees-0", TREES);
  g.register(vein, "town/vein-0", VEIN);
  const me = at(sim, 4, 0); // a metre from the stand's edge
  return { g, sim, tree, vein, me, clock, trained };
}

describe("GatheringSystem", () => {
  it("gathers one at a time into the pouch, within reach and past the cooldown, training the node's skill", () => {
    const { g, sim, tree, vein, me, clock, trained } = setup();
    const r = g.gather(sim, 7, me, tree);
    assert.deepEqual(r, { ok: true, material: "yew-log", name: "Yew log", count: 1 });
    assert.deepEqual(trained, [["woodcutting", 0.4, tree]]);
    assert.deepEqual(g.gather(sim, 7, me, tree), { ok: false, error: "still gathering" });
    clock.t += 1200;
    assert.equal(g.gather(sim, 7, me, tree).ok, true);
    assert.deepEqual(g.gather(sim, 7, me, vein), { ok: false, error: "too far away" });
    assert.deepEqual(g.gather(sim, 7, me, me), { ok: false, error: "nothing to gather there" });
    assert.deepEqual(g.pouchMessage(7).materials, [{ material: "yew-log", name: "Yew log", tier: 2, count: 2 }]);
    const changed = g.drainChanges(sim);
    assert.equal(changed.length, 1);
    assert.equal(changed[0]!.stock, 1);
    assert.equal(g.drainChanges(sim).length, 0, "drained");
  });

  it("works a node out, and it comes back after its regrow time; ore never does", () => {
    const { g, sim, tree, vein, me, clock } = setup();
    for (let i = 0; i < 3; i++, clock.t += 1200) assert.equal(g.gather(sim, 1, me, tree).ok, true);
    const out = g.gather(sim, 1, me, tree);
    assert.equal(out.ok, false);
    assert.match((out as { error: string }).error, /comes back in about 72 hours/);
    const view = g.views(sim).find((v) => v.kind === "tree_stand")!;
    assert.equal(view.stock, 0);
    assert.equal(view.regrowAt, 1_000_000 + 2 * 1200 + 72 * HOUR);
    clock.t = view.regrowAt! + 1;
    sim.currentTick = 30;
    g.drainChanges(sim);
    g.step(sim, 1 / 30);
    assert.equal(g.views(sim).find((v) => v.kind === "tree_stand")!.stock, 3, "grown back");
    assert.equal(g.drainChanges(sim).length, 1, "and the clients are told");

    Transform.px[me] = 52;
    for (let i = 0; i < 2; i++, clock.t += 1200) assert.equal(g.gather(sim, 1, me, vein).ok, true);
    assert.deepEqual(g.gather(sim, 1, me, vein), { ok: false, error: "the silver ore here is worked out for good" });
    assert.equal(g.views(sim).find((v) => v.kind === "ore_vein")!.regrowAt, null);
  });

  it("regrow pace and every other value follow gathering.json on a reload (EG11)", () => {
    const { g, sim, tree, me, clock } = setup();
    g.setRules(GatheringSchema.parse({ reachM: 0.5, cooldownSeconds: 2, regrowCheckSeconds: 5, regrowHourSeconds: 60 }));
    assert.deepEqual(g.gather(sim, 1, me, tree), { ok: false, error: "too far away" }, "reach shrank to half a metre");
    Transform.px[me] = 3.2;
    assert.equal(g.gather(sim, 1, me, tree).ok, true);
    clock.t += 1200;
    assert.deepEqual(g.gather(sim, 1, me, tree), { ok: false, error: "still gathering" }, "two seconds between gathers now");
    for (let i = 0; i < 2; i++) assert.equal((clock.t += 2000, g.gather(sim, 1, me, tree)).ok, true);
    const view = g.views(sim).find((v) => v.kind === "tree_stand")!;
    assert.equal(view.regrowAt, clock.t + 72 * 60_000, "72 regrow hours of a minute each");
    clock.t = view.regrowAt! + 1;
    g.drainChanges(sim);
    sim.currentTick = 30;
    g.step(sim, 1 / 30);
    assert.equal(g.views(sim).find((v) => v.kind === "tree_stand")!.stock, 0, "checked every 5 s, not every second");
    sim.currentTick = 150;
    g.step(sim, 1 / 30);
    assert.equal(g.views(sim).find((v) => v.kind === "tree_stand")!.stock, 3);
  });

  it("keeps stocks and pouches across a restart", () => {
    const db = new Database(":memory:");
    const first = setup(new SqliteGatheringStore(db));
    for (let i = 0; i < 2; i++, first.clock.t += 1200) first.g.gather(first.sim, 9, first.me, first.tree);
    const again = setup(new SqliteGatheringStore(db));
    assert.equal(again.g.views(again.sim).find((v) => v.kind === "tree_stand")!.stock, 1);
    assert.equal(again.g.countOf(9, "yew-log"), 2);
  });

  it("names materials by the crafting catalog, or by their id", () => {
    assert.equal(materialName("silver-ore"), "Silver ore");
    assert.equal(materialName("sea-fish"), "Sea fish");
  });
});

describe("scene resource nodes", () => {
  it("register as they spawn, a fishing spot on the water", () => {
    const sim = new SimWorld();
    const registered: Array<{ key: string; kind: string; material: string }> = [];
    const r = spawnScene(
      {
        version: 1,
        name: "settlement-t",
        kind: "world",
        nodes: [
          { id: "res-0", name: "ore_vein", transform: { position: [10, 0, 0] }, components: { Structure: { kind: "ore_vein", width: 3, depth: 2.5, height: 1.8 }, ResourceNode: { material: "iron-ore", tier: 1, skill: "Mining", stock: 60, regrowHours: 0 } } },
          { id: "res-1", name: "fishing_spot", transform: { position: [-10, 0, 0] }, components: { Structure: { kind: "fishing_spot", width: 4, depth: 4, height: 0.3 }, ResourceNode: { material: "sea-fish", tier: 1, skill: "Fishing", stock: 30, regrowHours: 6 }, Collider: { shape: "none" } } },
        ],
      },
      {
        sim,
        creatures: { has: () => false, spawnPack: () => [] },
        table: () => null,
        // The west is sea (ground 3 m under a surface at 0).
        groundHeightAt: (x) => (x < 0 ? -3 : 2),
        seaLevel: 0,
        resources: { register: (_eid, key, spec) => void registered.push({ key, kind: spec.kind, material: spec.material }) },
      },
    );
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(registered, [
      { key: "settlement-t/res-0", kind: "ore_vein", material: "iron-ore" },
      { key: "settlement-t/res-1", kind: "fishing_spot", material: "sea-fish" },
    ]);
    const spot = r.spawned.find((s) => s.id === "res-1")!.entities[0]!;
    assert.ok(Transform.py[spot]! >= 0, "the fishing spot floats on the water");
  });
});

describe("node stocks for the range snapshot (PL3a)", () => {
  it("lists every node and replaces them all with the world's copy", () => {
    const store = new SqliteGatheringStore(new Database(":memory:"));
    store.saveNode("town/oak-1", 4, null);
    store.saveNode("town/ore-1", 0, 1_700_000_000_000);
    assert.deepEqual(store.allNodes(), [
      { key: "town/oak-1", stock: 4, regrowAt: null },
      { key: "town/ore-1", stock: 0, regrowAt: 1_700_000_000_000 },
    ]);
    store.replaceNodes([{ key: "town/oak-1", stock: 1, regrowAt: null }]);
    assert.deepEqual(store.allNodes(), [{ key: "town/oak-1", stock: 1, regrowAt: null }]);
    assert.equal(store.loadNode("town/ore-1"), undefined, "a node the world doesn't hold is gone");
  });

  it("keeps only well-formed rows from the world", () => {
    assert.deepEqual(nodeStocksOf([{ key: "a", stock: 1, regrowAt: null }, { key: "b", stock: -1, regrowAt: null }, { key: 3, stock: 1, regrowAt: null }, null]), [{ key: "a", stock: 1, regrowAt: null }]);
    assert.deepEqual(nodeStocksOf("nope"), []);
  });
});
