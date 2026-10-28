/**
 * Scene spawning (roadmap EA6): a world scene's nodes become ordinary
 * entities through the creature and scatter spawn paths; a restart does
 * not duplicate them; a bad scene or a frontend scene is refused.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasComponent } from "bitecs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fnv1a32, parseSpawnTableJSON } from "@mmo-engine/scatter";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { CreatureSystem } from "../src/creatures.js";
import { loadGameRules } from "../src/rules/boot.js";
import { loadPrefabs, loadSceneFile, spawnScene, spawnSceneOnBoot, type SceneMeta } from "../src/scene-spawn.js";

const game = loadGameRules();
const table = parseSpawnTableJSON({ version: 1, archetypes: { oak: { asset: "oak" } } });

function setup() {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const creatures = new CreatureSystem({ creatures: game.rules.creatures.creatures, bases: game.rules.items.bases });
  const deps = { sim, creatures, table: () => table, groundHeightAt: (x: number, z: number) => 2 + x * 0 + z * 0 };
  return { sim, creatures, deps };
}

const doc = (nodes: unknown[], kind = "arena") => ({ version: 1, name: "t", kind, nodes });

describe("spawnScene", () => {
  it("spawns creatures and props where the nodes are, on the ground", () => {
    const { sim, creatures, deps } = setup();
    const r = spawnScene(
      doc([
        { id: "spawn", kind: "spawn-point", transform: { position: [0, 0, 0] } },
        { id: "camp", prefab: "camps/goblin", transform: { position: [20, 0, -10] }, components: { Spawner: { creature: "goblin", respawnSeconds: 60 } } },
        { id: "wolf", kind: "prefab", prefab: "goblin", transform: { position: [5, 0, 5] } },
        { id: "tree", kind: "prefab", prefab: "oak", transform: { position: [7, 1, 8], rotation: [0, 90, 0], scale: [2, 2, 2] } },
        { id: "nothing", prefab: "no-such-thing" },
      ]) as never,
      deps,
    );
    const by = (id: string) => r.spawned.find((s) => s.id === id)!;
    assert.ok(by("camp").entities.length >= 1);
    assert.ok(by("wolf").entities.every((e) => creatures.isCreature(e)));
    for (const e of by("camp").entities) {
      assert.ok(Math.abs(C.Transform.px[e] - 20) < 5 && Math.abs(C.Transform.pz[e] + 10) < 5);
    }
    const tree = by("tree").entities[0];
    assert.equal(C.Transform.px[tree], 7);
    assert.equal(C.Transform.py[tree], 3, "node height sits on the ground height");
    assert.equal(C.Transform.sx[tree], 2);
    assert.ok(Math.abs(C.Transform.qy[tree] - Math.sin(Math.PI / 4)) < 1e-6, "yaw 90 degrees");
    assert.equal(sim.resolveWireId(sim.wireId(tree)), tree);
    assert.deepEqual(r.skipped.map((s) => s.id).sort(), ["nothing", "spawn"]);
  });

  it("composes a child under its parent", () => {
    const { deps } = setup();
    const r = spawnScene(
      doc([{ id: "g", transform: { position: [100, 0, 0] }, children: [{ id: "tree", prefab: "oak", transform: { position: [1, 0, 0] } }] }]) as never,
      deps,
    );
    assert.equal(C.Transform.px[r.spawned[0].entities[0]], 101);
  });
});

describe("data-driven entities in a scene", () => {
  it("instantiates prefab files: the bundle, the node's overrides and the prefab's children", () => {
    const { deps } = setup();
    const prefabs = {
      "goblin-camp": {
        version: 1,
        name: "goblin-camp",
        components: { Spawner: { creature: "goblin" } },
        children: [{ id: "lookout", transform: { position: [10, 0, 0] }, components: { Spawner: { creature: "goblin" } } }],
      },
    };
    const r = spawnScene(doc([{ id: "camp", prefab: "goblin-camp", transform: { position: [100, 0, 0] } }]) as never, { ...deps, prefabs: prefabs as never });
    assert.deepEqual(r.spawned.map((s) => s.id), ["camp", "camp.lookout"]);
    const look = r.spawned[1].entities[0];
    assert.ok(Math.abs(C.Transform.px[look] - 110) < 5, "the child sits relative to the node");
    assert.deepEqual(r.skipped, []);
  });

  it("spawns a species at its roster pack size, and says why one can't spawn", () => {
    const { deps } = setup();
    // The repo's roster now defines a creature rule for every species, so the
    // "no creature rules" branch is exercised with a partial spawner set.
    const onlyGoblin = new CreatureSystem({ creatures: { goblin: game.rules.creatures.creatures.goblin }, bases: game.rules.items.bases });
    const species = (id: string) => (id === "goblin" ? { pack: [5, 5] as const } : id === "void-watcher" ? { pack: [1, 1] as const } : undefined);
    const r = spawnScene(
      doc([
        { id: "s", components: { Spawner: { species: "goblin" } } },
        { id: "v", components: { Spawner: { species: "void-watcher" } } },
        { id: "x", components: { Spawner: { species: "dragon" } } },
      ]) as never,
      { ...deps, creatures: onlyGoblin, species },
    );
    assert.equal(r.spawned[0].entities.length, 5);
    assert.ok(r.spawned[0].entities.every((e) => onlyGoblin.isCreature(e)));
    assert.match(r.skipped.find((s) => s.id === "v")!.reason, /no creature rules/);
    assert.match(r.skipped.find((s) => s.id === "x")!.reason, /no species "dragon"/);
  });

  it("places items and quest posts through the deps, and reports refusals", () => {
    const { deps } = setup();
    const placed: string[] = [];
    const moved: string[] = [];
    const items = {
      place: (base: string, rank: string | undefined, x: number, z: number) => (base === "sword" ? (placed.push(`${base}/${rank ?? "-"}@${x},${z}`), { item: 7 }) : null),
      discard: () => undefined,
    };
    const quests = { place: (q: string, x: number, z: number) => (q === "goblin-trouble" ? (moved.push(`${q}@${x},${z}`), null) : `no quest "${q}"`) };
    const r = spawnScene(
      doc([
        { id: "i", transform: { position: [3, 0, 4] }, components: { ItemSpawn: { base: "sword", rank: "rare" } } },
        { id: "no", components: { ItemSpawn: { base: "wand" } } },
        { id: "q", transform: { position: [8, 0, 9] }, components: { QuestGiver: { quest: "goblin-trouble" } } },
        { id: "nq", components: { QuestGiver: { quest: "ghost" } } },
      ]) as never,
      { ...deps, items, quests },
    );
    assert.deepEqual(placed, ["sword/rare@3,4"]);
    assert.deepEqual(moved, ["goblin-trouble@8,9"]);
    assert.deepEqual(r.spawned.map((s) => [s.id, s.items ?? []]), [["i", [7]], ["q", []]]);
    assert.deepEqual(r.skipped.map((s) => s.id), ["no", "nq"]);
  });

  it("discards the items an earlier boot placed before placing again", () => {
    const { deps } = setup();
    const data = new Map<string, string>();
    const meta: SceneMeta = { getMeta: (k) => data.get(k) ?? null, setMeta: (k, v) => void data.set(k, v) };
    const discarded: number[][] = [];
    const items = { place: () => ({ item: 11 }), discard: (ids: readonly number[]) => void discarded.push([...ids]) };
    const d = doc([{ id: "i", components: { ItemSpawn: { base: "sword" } } }]) as never;
    spawnSceneOnBoot(d, { ...deps, items }, meta);
    spawnSceneOnBoot(d, { ...deps, items }, meta);
    assert.deepEqual(discarded, [[11]]);
  });
});

describe("loadPrefabs", () => {
  const dir = join(tmpdir(), `mmo-prefabs-${process.pid}`);
  it("reads valid prefab files and refuses bad ones, listing each problem", () => {
    mkdirSync(dir, { recursive: true });
    try {
      assert.deepEqual(loadPrefabs(join(dir, "none")), {});
      writeFileSync(join(dir, "camp.prefab.json"), JSON.stringify({ version: 1, name: "camp", components: { Spawner: { creature: "goblin" } } }));
      assert.deepEqual(Object.keys(loadPrefabs(dir)), ["camp"]);
      writeFileSync(join(dir, "wrong.prefab.json"), JSON.stringify({ version: 1, name: "other" }));
      writeFileSync(join(dir, "bad.prefab.json"), JSON.stringify({ version: 1, name: "bad", components: { Nope: {} } }));
      assert.throws(() => loadPrefabs(dir), (e: Error) => /wrong\.prefab\.json: name must match/.test(e.message) && /bad\.prefab\.json: components\.Nope unknown component/.test(e.message));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spawnSceneOnBoot", () => {
  const fakeMeta = (): SceneMeta & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getMeta: (k) => data.get(k) ?? null, setMeta: (k, v) => void data.set(k, v) };
  };
  it("removes what the previous boot spawned before spawning again", () => {
    const { sim, deps } = setup();
    const meta = fakeMeta();
    const d = doc([{ id: "tree", prefab: "oak" }]) as never;
    const first = spawnSceneOnBoot(d, deps, meta);
    const oldWire = sim.wireId(first.spawned[0].entities[0]);
    assert.ok(sim.resolveWireId(oldWire) >= 0);
    spawnSceneOnBoot(d, deps, meta);
    assert.equal(sim.resolveWireId(oldWire), -1, "the previous boot's entity is gone");
    assert.equal(sim.liveEntityCount, 1);
    assert.equal(JSON.parse(meta.data.get("scene_entities")!).length, 1);
  });
});

describe("loadSceneFile", () => {
  const dir = join(tmpdir(), `mmo-scene-spawn-${process.pid}`);
  it("loads a valid world/arena scene and refuses bad names, invalid and frontend scenes", () => {
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, "a.scene.json"), JSON.stringify(doc([{ id: "x" }])));
      writeFileSync(join(dir, "bad.scene.json"), JSON.stringify({ version: 1, name: "bad", kind: "arena", nodes: [{}] }));
      writeFileSync(join(dir, "ui.scene.json"), JSON.stringify({ version: 1, name: "ui", kind: "frontend", nodes: [] }));
      assert.equal(loadSceneFile(dir, "a").name, "t");
      assert.throws(() => loadSceneFile(dir, "../a"), /bad scene name/);
      assert.throws(() => loadSceneFile(dir, "missing"), /no scene/);
      assert.throws(() => loadSceneFile(dir, "bad"), /invalid scene/);
      assert.throws(() => loadSceneFile(dir, "ui"), /frontend/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Collider nodes in a scene", () => {
  const collider = (id: string, c: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, transform: { position: [3, 1, 4] }, components: { Collider: c }, ...extra });

  it("spawns a bare node as a static box or sphere, with defaults for missing fields, on the ground", () => {
    const { deps } = setup();
    const r = spawnScene(doc([collider("wall", { shape: "box", hx: 2, hy: 3, hz: 0.25 }), collider("rock", { shape: "sphere", radius: 1.5 }), collider("def", {})]) as never, deps);
    const [wall, rock, def] = r.spawned.map((s) => s.entities[0]);
    assert.equal(C.BodyConfig.shapeKind[wall], C.ShapeKind.Box);
    assert.deepEqual([C.BodyConfig.halfX[wall], C.BodyConfig.halfY[wall], C.BodyConfig.halfZ[wall]], [2, 3, 0.25]);
    assert.equal(C.BodyConfig.motionType[wall], C.MotionType.Static);
    assert.equal(C.Transform.py[wall], 3, "node height sits on the ground height");
    assert.equal(C.BodyConfig.shapeKind[rock], C.ShapeKind.Sphere);
    assert.equal(C.BodyConfig.radius[rock], 1.5);
    assert.deepEqual([C.BodyConfig.halfX[def], C.BodyConfig.halfY[def], C.BodyConfig.halfZ[def]], [0.5, 0.5, 0.5]);
  });

  it('shape "none" is walk-through: no body, and a bare one spawns nothing', () => {
    const { deps } = setup();
    const r = spawnScene(doc([collider("ghost", { shape: "none" }), collider("tree", { shape: "none" }, { prefab: "oak" })]) as never, deps);
    assert.deepEqual(r.skipped.map((s) => s.id), ["ghost"]);
    const tree = r.spawned[0].entities[0];
    assert.ok(!hasComponent(deps.sim.ecs, C.BodyConfig, tree), "a prop's own collision is switched off");
  });

  it("overrides the collision of a prop prefab", () => {
    const { deps } = setup();
    const r = spawnScene(doc([collider("tree", { shape: "box", hx: 1, hy: 5, hz: 1 }, { prefab: "oak" })]) as never, deps);
    const e = r.spawned[0].entities[0];
    assert.equal(C.AssetRef.assetHash[e], fnv1a32("oak"));
    assert.deepEqual([C.BodyConfig.halfX[e], C.BodyConfig.halfY[e], C.BodyConfig.halfZ[e]], [1, 5, 1]);
  });
});

describe("structures in a scene", () => {
  const node = (id: string, structure: Record<string, unknown>) => ({ id, transform: { position: [10, 0, 20], rotation: [0, 90, 0] }, components: { Structure: structure } });

  it("spawns a Structure node as a static box centred on the ground, carrying the kind's asset hash", () => {
    const { deps } = setup();
    const r = spawnScene(doc([node("smithy-1", { kind: "smithy", width: 10, depth: 18, height: 4 }), { id: "blank", components: { Structure: { width: 4, depth: 4, height: 4 } } }]) as never, deps);
    const e = r.spawned.find((s) => s.id === "smithy-1")!.entities[0];
    assert.equal(r.spawned.find((s) => s.id === "smithy-1")!.what, "structure smithy");
    assert.equal(C.AssetRef.assetHash[e], fnv1a32("structure:smithy"));
    assert.equal(C.BodyConfig.shapeKind[e], C.ShapeKind.Box);
    assert.deepEqual([C.BodyConfig.halfX[e], C.BodyConfig.halfY[e], C.BodyConfig.halfZ[e]], [5, 4, 9], "half the footprint, the full height above and below the ground");
    assert.equal(C.BodyConfig.motionType[e], C.MotionType.Static);
    assert.equal(C.Transform.py[e], 2, "on the ground, so a model's base sits on it and a stand-in box shows its height above it");
    assert.ok(Math.abs(C.Transform.qy[e] - Math.sin(Math.PI / 4)) < 1e-6, "yaw 90 degrees");
    assert.deepEqual(r.skipped.map((s) => s.id), ["blank"]);
  });

  it("carries the named art model's hash when the node names one", () => {
    const { deps } = setup();
    const r = spawnScene(doc([node("smithy-2", { kind: "smithy", asset: "pack/Smithy_01", width: 10, depth: 18, height: 4 })]) as never, deps);
    assert.equal(C.AssetRef.assetHash[r.spawned[0].entities[0]], fnv1a32("pack/Smithy_01"));
  });

  // The footprint of `node` (10 x 18, yaw 90 at (10, 20)): the local x axis lies along world z, the local z axis along world -x... so 18 m along x, 10 m along z.
  const footprint = (): Array<[number, number]> => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= 36; i++) for (let j = 0; j <= 20; j++) pts.push([10 - 9 + i * 0.5, 20 - 5 + j * 0.5]);
    return pts;
  };

  it("stands a building on the highest ground under its footprint, so no side sinks into a slope", () => {
    const { deps } = setup();
    const ground = (x: number, _z: number): number => 0.1 * x; // a 10 percent slope along x: 1.8 m across the 18 m footprint
    const r = spawnScene(doc([node("smithy-3", { kind: "smithy", width: 10, depth: 18, height: 4 })]) as never, { ...deps, groundHeightAt: ground });
    const e = r.spawned[0].entities[0];
    const highest = Math.max(...footprint().map(([x, z]) => ground(x, z)));
    assert.ok(C.Transform.py[e] >= highest && C.Transform.py[e] - highest < 0.06, `floor at ${C.Transform.py[e]}, highest ground ${highest} (plus a plinth of a few cm)`);
    for (const [x, z] of footprint()) assert.ok(ground(x, z) <= C.Transform.py[e] + 1e-5, `ground ${ground(x, z)} at ${x},${z} is above the floor`);
    const lowest = Math.min(...footprint().map(([x, z]) => ground(x, z)));
    assert.ok(C.Transform.py[e] - C.BodyConfig.halfY[e] <= lowest + 1e-5, "the body reaches the lowest ground");
  });

  it("fills the gap under the high side with a foundation slab from the lowest ground up to the floor", () => {
    const { deps } = setup();
    const ground = (x: number, _z: number): number => 0.1 * x;
    const r = spawnScene(doc([node("smithy-4", { kind: "smithy", width: 10, depth: 18, height: 4 })]) as never, { ...deps, groundHeightAt: ground });
    const [building, slab] = r.spawned[0].entities;
    assert.equal(r.spawned[0].entities.length, 2);
    const drop = C.Transform.py[building] - Math.min(...footprint().map(([x, z]) => ground(x, z)));
    assert.ok(Math.abs(C.Transform.py[slab] + C.BodyConfig.halfY[slab] - C.Transform.py[building]) < 1e-5, "the slab's top is the floor");
    assert.ok(Math.abs(C.Transform.py[slab] - C.BodyConfig.halfY[slab] - (C.Transform.py[building] - drop)) < 1e-5, "the slab's underside is the lowest ground");
    assert.deepEqual([C.BodyConfig.halfX[slab], C.BodyConfig.halfZ[slab]], [C.BodyConfig.halfX[building], C.BodyConfig.halfZ[building]], "as wide as the building");
    assert.equal(C.BodyConfig.motionType[slab], C.MotionType.Static);
  });

  it("reaches the lowest ground even when the drop is taller than the building", () => {
    const { deps } = setup();
    const ground = (x: number, _z: number): number => 1 * x; // 100 percent: 18 m across the footprint, the building is 4 m tall
    const r = spawnScene(doc([node("smithy-5", { kind: "smithy", width: 10, depth: 18, height: 4 })]) as never, { ...deps, groundHeightAt: ground });
    const e = r.spawned[0].entities[0];
    assert.ok(C.Transform.py[e] - C.BodyConfig.halfY[e] <= 1 + 1e-5, "the body's underside is at or below the lowest ground (x = 1)");
  });

  it("adds no foundation on flat ground", () => {
    const { deps } = setup();
    const r = spawnScene(doc([node("smithy-6", { kind: "smithy", width: 10, depth: 18, height: 4 })]) as never, deps);
    assert.equal(r.spawned[0].entities.length, 1);
  });

  it("makes a Structure with a Collider of shape none walk-through (a town gate), with no foundation slab", () => {
    const { deps } = setup();
    const gate = { id: "gate-1", transform: { position: [10, 0, 20] }, components: { Structure: { kind: "town_gate", width: 8, depth: 2, height: 8 }, Collider: { shape: "none" } } };
    const r = spawnScene(doc([gate]) as never, { ...deps, groundHeightAt: (x: number) => 0.1 * x });
    assert.equal(r.spawned[0]!.what, "structure town_gate");
    assert.equal(r.spawned[0]!.entities.length, 1, "no slab under the road");
    const e = r.spawned[0]!.entities[0]!;
    assert.equal(C.AssetRef.assetHash[e], fnv1a32("structure:town_gate"));
    assert.ok(!hasComponent(deps.sim.ecs, C.BodyConfig, e), "no body: nothing to bump into");
  });
});

describe("sea level in a scene", () => {
  const house = (id: string, x = 10, z = 20) => ({ id, transform: { position: [x, 0, z] }, components: { Structure: { kind: "house", width: 6, depth: 6, height: 3 } } });
  const tree = (id: string, x = 10, z = 20) => ({ id, kind: "prefab", prefab: "oak", transform: { position: [x, 0, z] } });
  const run = (nodes: unknown[], ground: (x: number, z: number) => number, extra: object = {}) => {
    const { deps } = setup();
    return spawnScene(doc(nodes) as never, { ...deps, groundHeightAt: ground, seaLevel: 0, ...extra });
  };

  it("refuses a house under water, with the reason, instead of drowning it", () => {
    const r = run([house("drowned"), house("dry", 100, 20)], (x) => (x < 50 ? -2 : 5));
    assert.deepEqual(r.spawned.map((s) => s.id), ["dry"]);
    assert.match(r.skipped.find((s) => s.id === "drowned")!.reason, /under water|below the water/);
  });

  it("refuses a house on a shore parcel: any part of the footprint within a metre of the water", () => {
    const slope = (x: number): number => (x - 7) * 0.5; // the footprint (x 7..13) climbs from 0 to 3 m
    assert.equal(run([house("shore")], slope).spawned.length, 0);
    assert.equal(run([house("ok")], (x) => 1 + (x - 7) * 0.5).spawned.length, 1, "lowest point exactly 1 m up");
    assert.equal(run([house("close")], (x) => 0.99 + (x - 7) * 0.5).spawned.length, 0, "a hair under");
  });

  it("refuses a house on a river or lake cell, and under a lake's surface", () => {
    assert.equal(run([house("riv")], () => 5, { riverAt: () => true }).spawned.length, 0);
    assert.equal(run([house("lake")], () => 40, { waterAt: () => 40.5 }).spawned.length, 0);
    assert.equal(run([house("far")], () => 40, { waterAt: () => 10 }).spawned.length, 1);
  });

  it("refuses a land prop below the water or inside the margin; one exactly at the margin stands", () => {
    assert.equal(run([tree("sunk")], () => -2).spawned.length, 0);
    assert.match(run([tree("sunk")], () => -2).skipped[0].reason, /water/);
    assert.equal(run([tree("wet")], () => 0.29).spawned.length, 0);
    assert.equal(run([tree("edge")], () => 0.3).spawned.length, 1);
  });

  it("an aquatic prop (habitat water) stands on the sea floor within its depths", () => {
    const { deps } = setup();
    const coral = parseSpawnTableJSON({ version: 1, archetypes: { coral: { asset: "coral", habitat: "water", depthM: [1, 6] } } });
    const go = (g: number) => spawnScene(doc([{ id: "c", kind: "prefab", prefab: "coral", transform: { position: [1, 0, 1] } }]) as never, { ...deps, table: () => coral, groundHeightAt: () => g, seaLevel: 0 }).spawned.length;
    assert.equal(go(-2), 1);
    assert.equal(go(3), 0);
  });

  it("without any water known, nothing is refused (legacy worlds)", () => {
    const { deps } = setup();
    assert.equal(spawnScene(doc([house("h")]) as never, { ...deps, groundHeightAt: () => -50 }).spawned.length, 1);
  });
});
