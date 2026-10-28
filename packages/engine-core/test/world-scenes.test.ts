/**
 * Every baked town at once: MMO_SCENE as a list or `world` (every settlement-* scene plus
 * places), one settlement per town, one boot record for all the scenes, a shard's range.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpawnTableJSON } from "@mmo-engine/scatter";
import { SimWorld } from "../src/world.js";
import { CreatureSystem } from "../src/creatures.js";
import { loadGameRules } from "../src/rules/boot.js";
import { loadScenes, sceneNames, spawnSceneOnBoot, type SceneMeta } from "../src/scene-spawn.js";
import { townSettlements } from "../src/procgen/wildlife-settlements.js";

const house = (id: string, x: number) => ({ id, name: "house", transform: { position: [x, 0, 0] }, components: { Structure: { kind: "house", asset: "", width: 4, depth: 4, height: 3 } } });
const scene = (name: string, nodes: unknown[]) => ({ version: 1, name, kind: "world", nodes });

describe("world scenes", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmo-world-scenes-"));
  writeFileSync(join(dir, "settlement-0002.scene.json"), JSON.stringify(scene("settlement-0002", [house("b1", 500), house("b2", 510)])));
  writeFileSync(join(dir, "settlement-0001.scene.json"), JSON.stringify(scene("settlement-0001", [house("a1", 0), house("a2", 10)])));
  writeFileSync(join(dir, "places.scene.json"), JSON.stringify(scene("places", [house("p1", -900), house("p2", 900)])));

  it("reads a list, and `world` as every town then places", () => {
    assert.deepEqual(sceneNames(dir, "world"), ["settlement-0001", "settlement-0002", "places"]);
    assert.deepEqual(sceneNames(dir, " settlement-0002 ,places,settlement-0002"), ["settlement-0002", "places"]);
    assert.deepEqual(sceneNames(dir, "places,world"), ["places", "settlement-0001", "settlement-0002"]);
  });

  it("makes one settlement per town, none of the places", () => {
    const s = townSettlements(loadScenes(dir, "world"));
    assert.deepEqual(s.map((t) => [t.x, t.size, t.radius]), [[5, 2, 5], [505, 2, 5]]);
  });

  it("spawns every scene under one boot record, and only a shard's range", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const game = loadGameRules();
    const creatures = new CreatureSystem({ creatures: game.rules.creatures.creatures, bases: game.rules.items.bases });
    const table = parseSpawnTableJSON({ version: 1, archetypes: {} });
    const kv = new Map<string, string>();
    const meta: SceneMeta = { getMeta: (k) => kv.get(k) ?? null, setMeta: (k, v) => void kv.set(k, v) };
    const deps = { sim, creatures, table: () => table, inRange: (x: number) => x >= 0 };
    const scenes = loadScenes(dir, "world");
    const r = spawnSceneOnBoot(scenes, deps, meta);
    assert.deepEqual(r.spawned.map((s) => s.id), ["a1", "a2", "b1", "b2", "p2"]);
    assert.deepEqual(r.skipped, [{ id: "p1", reason: "outside this region's range" }]);
    const live = sim.liveEntityCount;
    spawnSceneOnBoot(scenes, deps, meta); // a restart: the record removes the first boot's entities
    assert.equal(sim.liveEntityCount, live);
  });
});
