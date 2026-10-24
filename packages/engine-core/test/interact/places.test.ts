/**
 * Place records (IX5): a prop that broke, a chest that was opened and a door left open
 * survive a restart (the scene spawns again; the store says what to do to it), come back on
 * their timers, and ride the snapshot rows.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { addComponent, defineQuery, entityExists, hasComponent } from "bitecs";
import { AssetRef, BodyConfig, Breakable, Health, Transform } from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import { BreakSystem, ChestSystem, placeRecordsOf, SqlitePlacesStore } from "../../src/interact/index.js";

function prop(sim: SimWorld, x: number, z: number): number {
  const e = sim.spawn();
  addComponent(sim.ecs, Transform, e);
  Transform.px[e] = x;
  Transform.pz[e] = z;
  Transform.qw[e] = 1;
  Transform.sx[e] = Transform.sy[e] = Transform.sz[e] = 1;
  addComponent(sim.ecs, AssetRef, e);
  AssetRef.assetHash[e] = 77;
  addComponent(sim.ecs, BodyConfig, e);
  BodyConfig.halfX[e] = 1.5;
  BodyConfig.halfY[e] = 2;
  BodyConfig.halfZ[e] = 0.5;
  return e;
}

const REMOVE = { health: 20, into: "remove" as const, respawnS: 60 };
const VARIANT = { health: 20, into: "variant" as const, respawnS: null };

describe("SqlitePlacesStore", () => {
  it("round-trips records and replaces them whole", () => {
    const store = new SqlitePlacesStore(new Database(":memory:"));
    store.save({ kind: "break", key: "a", state: "broken", at: 1, respawnAt: null });
    store.save({ kind: "chest", key: "a", state: "open", at: 2, respawnAt: 9 });
    assert.deepEqual(store.load("chest", "a"), { kind: "chest", key: "a", state: "open", at: 2, respawnAt: 9 });
    assert.equal(store.all().length, 2);
    store.replaceAll(placeRecordsOf([{ kind: "break", key: "b", state: "broken", at: 3, respawnAt: null }, { nonsense: true }]));
    assert.deepEqual(store.all().map((r) => r.key), ["b"]);
    store.clear("break", "b");
    assert.equal(store.all().length, 0);
  });
});

describe("BreakSystem with a places store", () => {
  it("a broken prop stays broken across a restart, and comes back on its timer", () => {
    const store = new SqlitePlacesStore(new Database(":memory:"));
    const clock = { t: 1_000_000 };
    // First life: the prop breaks and is saved.
    const sim1 = new SimWorld();
    const b1 = new BreakSystem(new Map(), { store, now: () => clock.t });
    const e1 = prop(sim1, 4, 5);
    b1.register(sim1, e1, "places/P1", REMOVE);
    assert.equal(hasComponent(sim1.ecs, Breakable, e1), true);
    Health.current[e1] = 0;
    b1.step(sim1);
    assert.equal(entityExists(sim1.ecs, e1), false);
    assert.deepEqual(store.load("break", "places/P1"), { kind: "break", key: "places/P1", state: "broken", at: 1_000_000, respawnAt: 1_060_000 });

    // Restart: the scene spawns it whole; register applies the record.
    clock.t += 10_000;
    const sim2 = new SimWorld();
    const b2 = new BreakSystem(new Map(), { store, now: () => clock.t });
    const e2 = prop(sim2, 4, 5);
    b2.register(sim2, e2, "places/P1", REMOVE);
    assert.equal(entityExists(sim2.ecs, e2), false, "still broken");

    // Its time comes: it is back, as it was.
    clock.t += 50_000;
    b2.step(sim2);
    const back = defineQuery([Transform, Breakable])(sim2.ecs);
    assert.equal(back.length, 1, "spawned again");
    assert.deepEqual([Transform.px[back[0]!], Transform.pz[back[0]!], BodyConfig.halfX[back[0]!], Health.current[back[0]!]], [4, 5, 1.5, 20]);
    assert.equal(store.load("break", "places/P1"), undefined, "record cleared");
  });

  it("a prop left standing broken is whole again when its timer comes, and one that never respawns stays broken", () => {
    const store = new SqlitePlacesStore(new Database(":memory:"));
    const clock = { t: 5_000 };
    const sim = new SimWorld();
    const b = new BreakSystem(new Map(), { store, now: () => clock.t });
    const timed = prop(sim, 1, 1);
    b.register(sim, timed, "places/timed", { ...VARIANT, respawnS: 30 });
    const forever = prop(sim, 2, 2);
    b.register(sim, forever, "places/forever", VARIANT);
    Health.current[timed] = 0;
    Health.current[forever] = 0;
    b.step(sim);
    assert.equal(hasComponent(sim.ecs, BodyConfig, timed), false);
    assert.equal(hasComponent(sim.ecs, BodyConfig, forever), false);
    clock.t += 31_000;
    b.step(sim);
    assert.equal(hasComponent(sim.ecs, BodyConfig, timed), true, "the collider is back");
    assert.equal(AssetRef.variant[timed], 0);
    assert.deepEqual([Health.current[timed], BodyConfig.halfX[timed]], [20, 1.5]);
    assert.equal(hasComponent(sim.ecs, BodyConfig, forever), false, "no timer: stays broken");
    assert.equal(store.load("break", "places/forever")?.respawnAt, null);
    // After a restart the one with no timer is broken again at once.
    const sim2 = new SimWorld();
    const b2 = new BreakSystem(new Map(), { store, now: () => clock.t });
    const again = prop(sim2, 2, 2);
    b2.register(sim2, again, "places/forever", VARIANT);
    assert.equal(hasComponent(sim2.ecs, BodyConfig, again), false);
  });
});

describe("ChestSystem with a places store", () => {
  it("an opened chest is still empty after a restart until its refill, and a door stays open", () => {
    const store = new SqlitePlacesStore(new Database(":memory:"));
    const clock = { t: 1_000_000 };
    const opts = { drop: () => 1, store, now: () => clock.t };
    const sim = new SimWorld();
    const chests = new ChestSystem(opts);
    const chest = prop(sim, 10, 10);
    const door = prop(sim, 20, 10);
    const near = prop(sim, 11, 10);
    chests.register(chest, "arena/c", { table: "t", refillSeconds: 60 }, sim);
    chests.register(door, "arena/d", { kind: "door" }, sim);
    assert.equal(chests.open(sim, 7, near, chest).ok, true);
    Transform.px[near] = 19;
    assert.equal(chests.open(sim, 7, near, door).ok, true);
    assert.equal(hasComponent(sim.ecs, BodyConfig, door), false);

    clock.t += 5_000; // restart
    const sim2 = new SimWorld();
    const chests2 = new ChestSystem(opts);
    const chest2 = prop(sim2, 10, 10);
    const door2 = prop(sim2, 20, 10);
    const near2 = prop(sim2, 11, 10);
    chests2.register(chest2, "arena/c", { table: "t", refillSeconds: 60 }, sim2);
    chests2.register(door2, "arena/d", { kind: "door" }, sim2);
    assert.deepEqual(chests2.open(sim2, 7, near2, chest2), { ok: false, error: "the chest is empty" });
    assert.equal(hasComponent(sim2.ecs, BodyConfig, door2), false, "the door stands open");
    clock.t += 56_000;
    chests2.step();
    assert.equal(chests2.open(sim2, 7, near2, chest2).ok, true, "refilled");
  });
});

describe("scene nodes", () => {
  it("a Structure with a Breakable, a Chest or a Door component registers under scene/node", async () => {
    const { spawnScene } = await import("../../src/scene-spawn.js");
    const sim = new SimWorld();
    const seen: string[] = [];
    const r = spawnScene(
      {
        version: 1,
        name: "t",
        kind: "world",
        nodes: [
          { id: "wall", name: "wall", transform: { position: [10, 0, 0] }, components: { Structure: { kind: "wall", width: 4, depth: 1, height: 3 }, Breakable: { health: 80, into: "variant", respawnSeconds: 0 } } },
          { id: "box", name: "box", transform: { position: [20, 0, 0] }, components: { Structure: { kind: "chest", width: 1, depth: 1, height: 1 }, Chest: { table: "chest-common", refillSeconds: 30, requires: "key", consume: true } } },
          { id: "gate", name: "gate", transform: { position: [30, 0, 0] }, components: { Structure: { kind: "door", width: 3, depth: 1, height: 3 }, Door: { castSeconds: 1 } } },
        ],
      },
      {
        sim,
        creatures: { has: () => false, spawnPack: () => [] },
        table: () => null,
        breakables: { register: (_e, key, def) => void seen.push(`break ${key} ${def.health} ${def.into} ${def.respawnS}`) },
        chests: { register: (_e, key, spec) => void seen.push(`${spec.kind} ${key} ${spec.requires?.base ?? "-"} ${spec.castSeconds}`) },
      },
    );
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(seen, ["break t/wall 80 variant null", "chest t/box key 0", "door t/gate - 1"]);
  });
});
