/**
 * Scene spawning (roadmap EA6): a world scene's nodes become ordinary
 * entities through the creature and scatter spawn paths; a restart does
 * not duplicate them; a bad scene or a frontend scene is refused.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpawnTableJSON } from "@mmo-engine/scatter";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { CreatureSystem } from "../src/creatures.js";
import { loadGameRules } from "../src/rules/boot.js";
import { loadSceneFile, spawnScene, spawnSceneOnBoot, type SceneMeta } from "../src/scene-spawn.js";

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
