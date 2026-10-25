/**
 * Breakable props (IX4): an archetype with `breakable` spawns with Health and the
 * Breakable tag; DeathSystem leaves it alone; at zero BreakSystem removes it, leaves
 * it standing broken without a collider, or swaps it for debris, rolling its loot for
 * the last attacker.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defineQuery, entityExists, hasComponent } from "bitecs";
import { parseSpawnTableJSON } from "@mmo-engine/scatter";
import { BROKEN_VARIANT } from "@mmo-engine/protocol";
import { AssetRef, BodyConfig, Breakable, Health } from "../../src/components.js";
import { buildSpawn } from "../../src/admin/spawn.js";
import { spawnScatterEntity } from "../../src/procgen/scatter-spawn.js";
import { SimWorld } from "../../src/world.js";
import { DeathSystem } from "../../src/death.js";
import Database from "better-sqlite3";
import { fnv1a32 } from "@mmo-engine/scatter";
import { BreakSystem, breakDefsOf, SqlitePlacesStore, type BreakEvent } from "../../src/interact/index.js";

const TABLE = parseSpawnTableJSON({
  version: 1,
  archetypes: {
    "dungeon:barrel": { asset: "dungeon:barrel", collision: { halfExtents: [0.4, 1, 0.4], motion: "static", shape: "box" }, breakable: { health: 30, into: "debris", debris: "dungeon:debris", loot: "prop:barrel" } },
    "dungeon:shelf": { asset: "dungeon:shelf", collision: { halfExtents: [0.6, 2, 0.6], motion: "static", shape: "box" }, breakable: { health: 60, into: "variant" } },
    "world:bush": { asset: "world:bush", collision: { halfExtents: [0.4, 0.5, 0.4], motion: "static", shape: "box" }, breakable: { health: 10, respawnS: 60 } },
    "dungeon:crate": { asset: "dungeon:crate", collision: { halfExtents: [0.4, 0.5, 0.4], motion: "static", shape: "box" }, breakable: { health: 30, damageMultipliers: { blunt: 1.5, thrust: 0.5 } } },
    "dungeon:sack": { asset: "dungeon:sack", collision: { halfExtents: [0.3, 0.5, 0.3], motion: "static", shape: "box" }, breakable: { health: 10 } },
    "dungeon:debris": { asset: "dungeon:rubble", collision: { shape: "none" } },
  },
});

function put(sim: SimWorld, asset: string, x: number, z: number): number {
  const built = buildSpawn(TABLE, asset, x, 0, z, 0);
  if ("error" in built) throw new Error(built.error);
  return spawnScatterEntity(sim, built);
}

function setup() {
  const sim = new SimWorld();
  const events: BreakEvent[] = [];
  const debris: Array<[string, number, number]> = [];
  const breaks = new BreakSystem(breakDefsOf(TABLE), {
    killerOf: () => 99,
    onBreak: (_s, ev) => events.push(ev),
    spawnDebris: (_s, id, x, _y, z) => debris.push([id, x, z]),
  });
  return { sim, breaks, events, debris };
}

describe("BreakSystem", () => {
  it("spawns breakables with Health and the tag, and ignores them until the health is gone", () => {
    const { sim, breaks, events } = setup();
    const barrel = put(sim, "dungeon:barrel", 5, 5);
    assert.equal(hasComponent(sim.ecs, Breakable, barrel), true);
    assert.deepEqual([Health.current[barrel], Health.max[barrel]], [30, 30]);
    Health.current[barrel] = 12;
    breaks.step(sim);
    assert.equal(entityExists(sim.ecs, barrel), true);
    assert.equal(events.length, 0);
  });

  it("debris: the prop goes, the debris stands there, and its loot rolls for the last attacker", () => {
    const { sim, breaks, events, debris } = setup();
    const barrel = put(sim, "dungeon:barrel", 5, 7);
    Health.current[barrel] = 0;
    breaks.step(sim);
    assert.equal(entityExists(sim.ecs, barrel), false);
    assert.deepEqual(debris, [["dungeon:debris", 5, 7]]);
    assert.deepEqual(events.map((e) => [e.loot, e.killer, e.x, e.z]), [["prop:barrel", 99, 5, 7]]);
    assert.equal(breaks.broken, 1);
  });

  it("variant: it stays, broken, with no collider, no health and no tag", () => {
    const { sim, breaks, debris } = setup();
    const shelf = put(sim, "dungeon:shelf", 1, 1);
    assert.equal(hasComponent(sim.ecs, BodyConfig, shelf), true);
    Health.current[shelf] = 0;
    breaks.step(sim);
    assert.equal(entityExists(sim.ecs, shelf), true);
    assert.equal(AssetRef.variant[shelf], BROKEN_VARIANT);
    assert.deepEqual([hasComponent(sim.ecs, BodyConfig, shelf), hasComponent(sim.ecs, Health, shelf), hasComponent(sim.ecs, Breakable, shelf)], [false, false, false]);
    assert.equal(debris.length, 0);
    breaks.step(sim);
    assert.equal(breaks.broken, 1, "broken once");
  });

  it("remove: the entity goes and nothing stands in its place", () => {
    const { sim, breaks, debris } = setup();
    const sack = put(sim, "dungeon:sack", 2, 2);
    Health.current[sack] = 0;
    breaks.step(sim);
    assert.equal(entityExists(sim.ecs, sack), false);
    assert.equal(debris.length, 0);
  });

  it("a world scatter prop that broke comes back on its timer, even across a restart", () => {
    const store = new SqlitePlacesStore(new Database(":memory:"));
    const clock = { t: 1_000_000 };
    const sim = new SimWorld();
    const first = new BreakSystem(breakDefsOf(TABLE), { store, now: () => clock.t });
    const bush = put(sim, "world:bush", 7, 9);
    Health.current[bush] = 0;
    first.step(sim);
    assert.equal(entityExists(sim.ecs, bush), false, "it broke");
    assert.equal(store.all().length, 1, "and was written down");
    // The server restarts: a new system, the same store, the prop still gone.
    clock.t += 30_000;
    const second = new BreakSystem(breakDefsOf(TABLE), { store, now: () => clock.t });
    second.step(sim);
    const back = () => [...defineQuery([AssetRef])(sim.ecs)].filter((e) => AssetRef.assetHash[e] === fnv1a32("world:bush") >>> 0);
    assert.equal(back().length, 0, "not yet");
    clock.t += 31_000;
    second.step(sim);
    assert.equal(back().length, 1, "back after its minute");
    assert.equal(store.all().length, 0, "the record is cleared");
  });

  it("a prop takes more or less from each kind of blow, by its damage multipliers", () => {
    const { sim, breaks } = setup();
    const crate = put(sim, "dungeon:crate", 3, 3);
    const sack = put(sim, "dungeon:sack", 4, 4);
    assert.equal(breaks.kindScale(crate, "blunt"), 1.5);
    assert.equal(breaks.kindScale(crate, "thrust"), 0.5);
    assert.equal(breaks.kindScale(crate, "cut"), 1, "a kind it does not name counts 1");
    assert.equal(breaks.kindScale(sack, "blunt"), 1, "no table: 1");
  });

  it("DeathSystem leaves a breakable alone: it does not die and rise", () => {
    const { sim } = setup();
    const barrel = put(sim, "dungeon:barrel", 3, 3);
    Health.current[barrel] = 0;
    const died: unknown[] = [];
    const death = new DeathSystem({ onDeath: (c: unknown) => (died.push(c), { respawnSeconds: 1 }), onRespawn: () => ({}) } as never, 30);
    sim.beginTick(1);
    death.step(sim);
    assert.equal(died.length, 0, "no death rolled for a prop");
    assert.equal(Health.current[barrel], 0, "not refilled");
  });
});
