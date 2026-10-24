/**
 * Breakable props (IX4): an archetype with `breakable` spawns with Health and the
 * Breakable tag; DeathSystem leaves it alone; at zero BreakSystem removes it, leaves
 * it standing broken without a collider, or swaps it for debris, rolling its loot for
 * the last attacker.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { entityExists, hasComponent } from "bitecs";
import { parseSpawnTableJSON } from "@mmo-engine/scatter";
import { BROKEN_VARIANT } from "@mmo-engine/protocol";
import { AssetRef, BodyConfig, Breakable, Health } from "../../src/components.js";
import { buildSpawn } from "../../src/admin/spawn.js";
import { spawnScatterEntity } from "../../src/procgen/scatter-spawn.js";
import { SimWorld } from "../../src/world.js";
import { DeathSystem } from "../../src/death.js";
import { BreakSystem, breakDefsOf, type BreakEvent } from "../../src/interact/index.js";

const TABLE = parseSpawnTableJSON({
  version: 1,
  archetypes: {
    "dungeon:barrel": { asset: "dungeon:barrel", collision: { halfExtents: [0.4, 1, 0.4], motion: "static", shape: "box" }, breakable: { health: 30, into: "debris", debris: "dungeon:debris", loot: "prop:barrel" } },
    "dungeon:shelf": { asset: "dungeon:shelf", collision: { halfExtents: [0.6, 2, 0.6], motion: "static", shape: "box" }, breakable: { health: 60, into: "variant" } },
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
