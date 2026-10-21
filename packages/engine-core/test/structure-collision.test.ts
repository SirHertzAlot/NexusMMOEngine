/**
 * Settlement buildings block walkers: a scene `Structure` node spawned through
 * spawnScene is a static box, and a real kinematic character (Intent +
 * Integrate + PropCollision) cannot walk into it from any side, at any yaw,
 * but passes over it (Y interval), through the street between two parcels, and
 * still finds the body after a re-boot of the scene.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { parseSpawnTableJSON } from "@mmo-engine/scatter";
import {
  attachDefaultCollider,
  BodyConfig,
  CHARACTER_CAPSULE,
  IntegrateSystem,
  IntentSystem,
  MotionType,
  PlayerIntent,
  PropCollisionSystem,
  ShapeKind,
  SimWorld,
  STEP_MS,
  Transform,
} from "../src/index.js";
import { CreatureSystem } from "../src/creatures.js";
import { loadGameRules } from "../src/rules/boot.js";
import { spawnScene, spawnSceneOnBoot, type SceneMeta } from "../src/scene-spawn.js";

const dt = STEP_MS / 1000;
const R = CHARACTER_CAPSULE.radius;
const game = loadGameRules();
const table = parseSpawnTableJSON({ version: 1, archetypes: {} });

// The settlement's parcel grid: 12 x 20 m parcels, 10 x 18 m footprints, 4 m tall.
const W = 10;
const D = 18;
const H = 4;
const structure = (id: string, x: number, z: number, yaw = 0) => ({
  id,
  transform: { position: [x, 0, z], rotation: [0, yaw, 0] },
  components: { Structure: { kind: "house", width: W, depth: D, height: H } },
});
const scene = (nodes: unknown[]) => ({ version: 1, name: "t", kind: "world", nodes }) as never;

function setup() {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const creatures = new CreatureSystem({ creatures: game.rules.creatures.creatures, bases: game.rules.items.bases });
  return { sim, deps: { sim, creatures, table: () => table } };
}

function walker(sim: SimWorld, x: number, y: number, z: number): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  Transform.px[eid] = x;
  Transform.py[eid] = y;
  Transform.pz[eid] = z;
  Transform.qw[eid] = 1;
  addComponent(sim.ecs, PlayerIntent, eid);
  attachDefaultCollider(sim, eid);
  return eid;
}

function walk(sim: SimWorld, eid: number, mx: number, mz: number, ticks: number): void {
  const systems = [new IntentSystem(), new IntegrateSystem(), new PropCollisionSystem()];
  for (let t = 0; t < ticks; t++) {
    PlayerIntent.mx[eid] = mx;
    PlayerIntent.mz[eid] = mz;
    for (const s of systems) s.step(sim, dt);
  }
}

/** Distance from (px, pz) to the box (centre cx, cz; half w/2, d/2; yaw degrees); 0 when inside. */
function distToBox(px: number, pz: number, cx: number, cz: number, yawDeg: number): number {
  const a = (yawDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = px - cx;
  const dz = pz - cz;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.hypot(Math.max(Math.abs(lx) - W / 2, 0), Math.max(Math.abs(lz) - D / 2, 0));
}

for (const yaw of [0, 90, 35]) {
  test(`a walker never enters a structure from any side (yaw ${yaw})`, () => {
    for (let k = 0; k < 8; k++) {
      const { sim, deps } = setup();
      spawnScene(scene([structure("b", 100, 200, yaw)]), deps);
      const a = (k * Math.PI) / 4;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const player = walker(sim, 100 + dx * 20, 0, 200 + dz * 20);
      // Sliding may carry it past a corner, so check every tick: never inside, and it did arrive at the wall.
      let closest = Infinity;
      for (let t = 0; t < 600; t++) {
        walk(sim, player, -dx, -dz, 1);
        closest = Math.min(closest, distToBox(Transform.px[player], Transform.pz[player], 100, 200, yaw));
      }
      assert.ok(closest >= R - 1e-3, `direction ${k}: inside the building, ${closest.toFixed(3)} m from its wall`);
      assert.ok(closest <= R + 0.5, `direction ${k}: never reached the building (${closest.toFixed(3)} m)`);
    }
  });
}

test("a flying or jumping character clears a structure, and one below the roof line is blocked", () => {
  const { sim, deps } = setup();
  spawnScene(scene([structure("b", 100, 200)]), deps);
  const over = walker(sim, 70, H + 0.01, 200);
  walk(sim, over, 1, 0, 600);
  assert.ok(Transform.px[over] > 130, `blocked above the roof: x=${Transform.px[over]}`);
  const low = walker(sim, 70, H - 0.5, 200);
  walk(sim, low, 1, 0, 600);
  assert.ok(Transform.px[low] < 100 - W / 2, `walked in below the roof line: x=${Transform.px[low]}`);
});

test("two adjacent parcels leave a street a character can walk, and each wall still blocks from the seam", () => {
  const { sim, deps } = setup();
  // Parcel centres 12 m apart: footprints [95,105] and [107,117], street x in (105,107), seam x=106.
  spawnScene(scene([structure("a", 100, 200), structure("b", 112, 200)]), deps);
  const along = walker(sim, 106, 0, 170);
  walk(sim, along, 0, 1, 600);
  assert.ok(Transform.pz[along] > 230, `the street is blocked: z=${Transform.pz[along]}`);
  assert.ok(Math.abs(Transform.px[along] - 106) < 1e-3);
  const left = walker(sim, 106, 0, 200);
  walk(sim, left, -1, 0, 120);
  assert.ok(Transform.px[left] >= 105 + R - 1e-3, `walked into the left building: x=${Transform.px[left]}`);
  const right = walker(sim, 106, 0, 200);
  walk(sim, right, 1, 0, 120);
  assert.ok(Transform.px[right] <= 107 - R + 1e-3, `walked into the right building: x=${Transform.px[right]}`);
});

test("a re-booted scene keeps its structure bodies and does not duplicate them", () => {
  const { sim, deps } = setup();
  const data = new Map<string, string>();
  const meta: SceneMeta = { getMeta: (k) => data.get(k) ?? null, setMeta: (k, v) => void data.set(k, v) };
  const doc = scene([structure("a", 100, 200), structure("b", 112, 200)]);
  const first = spawnSceneOnBoot(doc, deps, meta);
  const oldWires = first.spawned.map((s) => sim.wireId(s.entities[0]));
  const second = spawnSceneOnBoot(doc, deps, meta);
  for (const w of oldWires) assert.equal(sim.resolveWireId(w), -1, "the previous boot's building is gone");
  assert.equal(sim.liveEntityCount, 2, "no duplicates");
  assert.equal(JSON.parse(data.get("scene_entities")!).length, 2);
  for (const s of second.spawned) {
    const e = s.entities[0];
    assert.equal(BodyConfig.shapeKind[e], ShapeKind.Box);
    assert.equal(BodyConfig.motionType[e], MotionType.Static);
    assert.deepEqual([BodyConfig.halfX[e], BodyConfig.halfY[e], BodyConfig.halfZ[e]], [W / 2, H, D / 2]);
  }
  const player = walker(sim, 70, 0, 200);
  walk(sim, player, 1, 0, 600);
  assert.ok(Transform.px[player] <= 100 - W / 2 - R + 1e-3, `walked through the re-booted building: x=${Transform.px[player]}`);
});
