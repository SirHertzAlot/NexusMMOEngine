/**
 * Prop collision: players must not walk through scatter-spawned terrain
 * props (trees, rocks).
 *
 * Root-cause hypothesis (docs/ROADMAP.md §5: CharacterVirtual is still
 * planned): characters are kinematic capsules moved by IntegrateSystem,
 * and PhysicsSystem only ever copies results back for *dynamic* bodies —
 * so a kinematic walker's move is never resolved against static Jolt
 * bodies. Static bodies already cut the navmesh (crowds path round
 * props); only the character step ignores them. This suite pins the fix:
 * a JS-side resolution of kinematic movers against static BodyConfig
 * boxes/spheres, in/around the integrate step.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { addComponent, hasComponent } from "bitecs";
import {
  AssetRef,
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
  Velocity,
} from "../src/index.js";
import { Noclip as NoclipTag } from "../src/components.js";

const dt = STEP_MS / 1000;

/** A static box prop at (x, y, z), e.g. the oak in forest.spawn-table.json. */
function spawnBoxProp(
  sim: SimWorld,
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, AssetRef, eid);
  Transform.px[eid] = x;
  Transform.py[eid] = y;
  Transform.pz[eid] = z;
  Transform.qw[eid] = 1;
  addComponent(sim.ecs, Velocity, eid);
  addComponent(sim.ecs, BodyConfig, eid);
  BodyConfig.shapeKind[eid] = ShapeKind.Box;
  BodyConfig.halfX[eid] = hx;
  BodyConfig.halfY[eid] = hy;
  BodyConfig.halfZ[eid] = hz;
  BodyConfig.radius[eid] = 0;
  BodyConfig.mass[eid] = 0;
  BodyConfig.motionType[eid] = MotionType.Static;
  BodyConfig.layer[eid] = 0;
  BodyConfig.friction[eid] = 0.8;
  BodyConfig.restitution[eid] = 0;
  return eid;
}

/** A static sphere prop (a rock) at (x, y, z) with radius r. */
function spawnSphereProp(sim: SimWorld, x: number, y: number, z: number, r: number): number {
  const eid = spawnBoxProp(sim, x, y, z, 0, 0, 0);
  BodyConfig.shapeKind[eid] = ShapeKind.Sphere;
  BodyConfig.radius[eid] = r;
  return eid;
}

/** A walking player at (x, y, z): kinematic capsule via the collider default. */
function spawnWalker(sim: SimWorld, x: number, y: number, z: number): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  Transform.px[eid] = x;
  Transform.py[eid] = y;
  Transform.pz[eid] = z;
  Transform.qw[eid] = 1;
  addComponent(sim.ecs, PlayerIntent, eid);
  attachDefaultCollider(sim, eid);
  assert.equal(BodyConfig.shapeKind[eid], ShapeKind.Capsule);
  assert.equal(BodyConfig.motionType[eid], MotionType.Kinematic);
  return eid;
}

/** Walk `ticks` ticks of intent -> integrate -> prop-collision. */
function walk(
  sim: SimWorld,
  systems: { step(s: SimWorld, dt: number): void }[],
  eid: number,
  mx: number,
  mz: number,
  ticks: number,
): void {
  for (let t = 0; t < ticks; t++) {
    PlayerIntent.mx[eid] = mx;
    PlayerIntent.mz[eid] = mz;
    for (const s of systems) s.step(sim, dt);
  }
}

function pipeline(): { step(s: SimWorld, dt: number): void }[] {
  return [new IntentSystem(), new IntegrateSystem(), new PropCollisionSystem()];
}

test("a walker is blocked by a static box prop (no walkthrough)", () => {
  const sim = new SimWorld();
  // Oak-like trunk: 1x4x1 m box centred at the terrain (y=0).
  spawnBoxProp(sim, 0, 0, 0, 0.5, 2.0, 0.5);
  const player = spawnWalker(sim, -3, 0, 0);
  walk(sim, pipeline(), player, 1, 0, 60);
  // The capsule (radius 0.35) stops at the box face x=-0.5, never inside it.
  const face = -0.5 - CHARACTER_CAPSULE.radius;
  assert.ok(
    Transform.px[player] <= face + 1e-3,
    `walked through the prop: x=${Transform.px[player]}, face=${face}`,
  );
  assert.ok(
    Transform.px[player] >= face - 0.25,
    `stuck too far from the prop: x=${Transform.px[player]}, face=${face}`,
  );
});

test("a walker slides along a box prop instead of sticking", () => {
  const sim = new SimWorld();
  spawnBoxProp(sim, 0, 0, 0, 0.5, 2.0, 0.5);
  const player = spawnWalker(sim, -3, 0, -0.5);
  // Mostly +x with a little +z: the walker pins against the -x face and
  // keeps travelling in z (30 ticks still leave it on the flat face).
  walk(sim, pipeline(), player, 1, 0.15, 30);
  // Blocked in x, still travelling in z (the diagonal slides along it).
  assert.ok(
    Transform.px[player] <= -0.5 - CHARACTER_CAPSULE.radius + 1e-3,
    `not blocked: x=${Transform.px[player]}`,
  );
  assert.ok(Transform.pz[player] > 0, `no slide: z=${Transform.pz[player]}`);
});

test("a walker is blocked by a static sphere prop (a rock)", () => {
  const sim = new SimWorld();
  spawnSphereProp(sim, 0, 0, 0, 1);
  const player = spawnWalker(sim, -4, 0, 0);
  walk(sim, pipeline(), player, 1, 0, 60);
  const stop = -(1 + CHARACTER_CAPSULE.radius);
  assert.ok(
    Transform.px[player] <= stop + 1e-3,
    `walked through the rock: x=${Transform.px[player]}, stop=${stop}`,
  );
  assert.ok(Transform.px[player] >= stop - 0.25);
});

test('collision "none" opts a prop out: walkers pass through grass', () => {
  const sim = new SimWorld();
  // Grass: scenery with no BodyConfig at all (spawnScatterEntity skips it).
  const grass = sim.spawn();
  addComponent(sim.ecs, Transform, grass);
  addComponent(sim.ecs, AssetRef, grass);
  Transform.qw[grass] = 1;
  assert.ok(!hasComponent(sim.ecs, BodyConfig, grass));
  const player = spawnWalker(sim, -3, 0, 0);
  walk(sim, pipeline(), player, 1, 0, 60);
  assert.ok(Transform.px[player] > 0.5, `blocked by nothing: x=${Transform.px[player]}`);
});

test("noclip passes through props", () => {
  const sim = new SimWorld();
  spawnBoxProp(sim, 0, 0, 0, 0.5, 2.0, 0.5);
  const player = spawnWalker(sim, -3, 0, 0);
  addComponent(sim.ecs, NoclipTag, player);
  walk(sim, pipeline(), player, 1, 0, 60);
  assert.ok(Transform.px[player] > 0.5, `noclip blocked: x=${Transform.px[player]}`);
});

test("flying over a prop does not collide (no vertical overlap)", () => {
  const sim = new SimWorld();
  spawnBoxProp(sim, 0, 0, 0, 0.5, 2.0, 0.5);
  // Feet at y=10: the capsule [10, 11.8] clears the box top (y=2).
  const player = spawnWalker(sim, -3, 10, 0);
  walk(sim, pipeline(), player, 1, 0, 60);
  assert.ok(Transform.px[player] > 0.5, `blocked mid-air: x=${Transform.px[player]}`);
});

test("a walker is blocked by a prop that straddles a grid cell boundary, among many props", () => {
  // The per-tick grid bins statics into 32 m cells. A prop spanning the
  // x = 64 boundary, with a field of other props around it, must still stop
  // a walker that reaches it from the cell on the near side.
  const sim = new SimWorld();
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 20; j++) spawnBoxProp(sim, 1000 + i * 40, 0, 1000 + j * 40, 0.5, 2, 0.5);
  }
  spawnBoxProp(sim, 64, 0, 0, 1.5, 2, 1.5); // spans x 62.5 .. 65.5
  const player = spawnWalker(sim, 40, 0, 0);
  walk(sim, pipeline(), player, 1, 0, 300);
  const face = 62.5 - CHARACTER_CAPSULE.radius;
  assert.ok(
    Transform.px[player] <= face + 1e-3,
    `walked through the boundary prop: x=${Transform.px[player]}, face=${face}`,
  );
  assert.ok(
    Transform.px[player] >= face - 0.25,
    `stuck too far from the boundary prop: x=${Transform.px[player]}, face=${face}`,
  );
});
