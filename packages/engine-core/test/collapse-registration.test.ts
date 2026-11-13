/**
 * A scene's modular buildings are handed to the collapse system (DE4): each `building:*` group's Structure parts
 * (`<id>-vis-N`, drawn at the model's pivot) with their collider nodes (`<id>-pN-col`); the box is round the model's
 * middle (the node's position plus its `centre*` offset, turned by its yaw) and the ground is the building's footing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseSpawnTableJSON } from "@mmo-engine/scatter";
import { SimWorld, Transform } from "../src/index.js";
import { CreatureSystem } from "../src/creatures.js";
import { loadGameRules } from "../src/rules/boot.js";
import { spawnScene } from "../src/scene-spawn.js";
import type { CollapsePartSpec } from "../src/interact/collapse.js";

const game = loadGameRules();
const table = parseSpawnTableJSON({ version: 1, archetypes: {} });

const part = (id: string, kind: string, x: number, y: number, z: number, w: number, h: number, d: number) => ({
  id,
  transform: { position: [x, y, z], rotation: [0, 0, 0] },
  components: { Structure: { kind, width: w, depth: d, height: h, centreX: 1, centreY: -1, centreZ: 0 } },
});
const col = (id: string, x: number, y: number, z: number) => ({
  id,
  prefab: "collider",
  transform: { position: [x, y, z], rotation: [0, 0, 0] },
  components: { Collider: { shape: "box", hx: 1, hy: 1, hz: 0.1 } },
});
const house = (id: string, ox: number, parts: number) => ({
  id,
  kind: "group",
  name: "building:house",
  transform: { position: [ox, 0, 0], rotation: [0, 0, 0] },
  children: [
    ...Array.from({ length: parts }, (_, i) => part(`${id}-vis-${i}`, i === 0 ? "floor" : "wall", i, 0, 0, 2, 2, 2)),
    col(`${id}-p1-col`, 1, 0, 0),
  ],
});

function run(nodes: unknown[]) {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const creatures = new CreatureSystem({ creatures: game.rules.creatures.creatures, bases: game.rules.items.bases });
  const got: Array<{ key: string; parts: readonly CollapsePartSpec[]; o: { groundY?: number; groundTol?: number } | undefined }> = [];
  const collapse = { registerBuilding: (_s: SimWorld, key: string, parts: readonly CollapsePartSpec[], o?: { groundY?: number; groundTol?: number }): void => void got.push({ key, parts, o }) };
  spawnScene({ version: 1, name: "t", kind: "world", nodes } as never, { sim, creatures, table: () => table, collapse });
  return { sim, got };
}

test("registers each modular building's parts with their middles and colliders", () => {
  const { got } = run([house("h1", 0, 4), house("h2", 30, 3)]);
  assert.deepEqual(got.map((g) => g.key), ["t/h1", "t/h2"]);
  const h1 = got[0]!.parts;
  assert.equal(h1.length, 4);
  assert.deepEqual(h1.map((p) => p.part.category), ["floor", "wall", "wall", "wall"]);
  for (const p of h1) {
    // The node is at its pivot; the box is round the middle, offset (1, -1, 0) from it.
    assert.ok(Math.abs(p.part.pos[0] - (Transform.px[p.eid]! + 1)) < 1e-4);
    assert.ok(Math.abs(p.part.pos[1] - (Transform.py[p.eid]! - 1)) < 1e-4);
    assert.deepEqual(p.part.size, [2, 2, 2]);
    assert.deepEqual(p.offset, [1, -1, 0]);
  }
  assert.equal(h1[1]!.colliders.length, 1, "part 1 has its collider node");
  assert.equal(h1[0]!.colliders.length, 0);
});

test("grounds a building at its footing", () => {
  const { got } = run([house("h1", 0, 4)]);
  assert.equal(got[0]!.o?.groundTol, 0.3);
  assert.equal(typeof got[0]!.o?.groundY, "number");
});

test("leaves a building with fewer than three parts, and plain structures, alone", () => {
  const { got } = run([house("tiny", 0, 2), part("lone", "house", 50, 0, 0, 4, 4, 4)]);
  assert.deepEqual(got, []);
});

test("is off without a collapse system", () => {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const creatures = new CreatureSystem({ creatures: game.rules.creatures.creatures, bases: game.rules.items.bases });
  const r = spawnScene({ version: 1, name: "t", kind: "world", nodes: [house("h1", 0, 4)] } as never, { sim, creatures, table: () => table });
  assert.ok(r.spawned.length > 0);
});
