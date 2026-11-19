/**
 * Persistence of collapse (DE4b): a part that came to rest is saved to the places store and put back where it lay
 * after a restart; a part whose visual the break system already removed counts as broken; a record from a different
 * building layout is ignored.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent, hasComponent } from "bitecs";
import Database from "better-sqlite3";
import type { SupportPart } from "@mmo-engine/placement";
import { AssetRef, BodyConfig, MotionType, Transform, Velocity } from "../../src/components.js";
import { CollapseSystem, type CollapsePartSpec } from "../../src/interact/collapse.js";
import { SqlitePlacesStore } from "../../src/interact/places-store.js";
import { SimWorld } from "../../src/world.js";

const DT = 1 / 30;

function entity(sim: SimWorld, pos: readonly [number, number, number], body: readonly [number, number, number] | null = null): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  Transform.px[eid] = pos[0];
  Transform.py[eid] = pos[1];
  Transform.pz[eid] = pos[2];
  Transform.qw[eid] = 1;
  Transform.sx[eid] = Transform.sy[eid] = Transform.sz[eid] = 1;
  if (body) {
    addComponent(sim.ecs, Velocity, eid);
    addComponent(sim.ecs, BodyConfig, eid);
    BodyConfig.shapeKind[eid] = 0;
    BodyConfig.halfX[eid] = body[0] / 2;
    BodyConfig.halfY[eid] = body[1] / 2;
    BodyConfig.halfZ[eid] = body[2] / 2;
    BodyConfig.motionType[eid] = MotionType.Static;
  }
  return eid;
}

const p = (category: string, pos: [number, number, number], size: [number, number, number]): SupportPart => ({ pos, size, yawDeg: 0, category, id: category });
// 0 floor, 1 north, 2 south, 3 east, 4 west, 5 roof, 6 door on the south wall.
const HOUSE: SupportPart[] = [
  p("floor", [0, 0.15, 0], [6, 0.3, 6]),
  p("wall", [0, 1.8, -2.9], [6, 3, 0.2]),
  p("wall", [0, 1.8, 2.9], [6, 3, 0.2]),
  p("wall", [2.9, 1.8, 0], [0.2, 3, 6]),
  p("wall", [-2.9, 1.8, 0], [0.2, 3, 6]),
  p("roof", [0, 3.45, 0], [6.4, 0.3, 6.4]),
  p("door", [0, 1.6, 2.9], [1, 2.2, 0.3]),
];
const OFFSET: [number, number, number] = [0.5, -0.2, 0];

/** One boot: a world with the house (a collider on the south wall and on the door) registered with the shared store. */
function boot(store: SqlitePlacesStore, opts: { breakSouthFirst?: boolean; layout?: number } = {}) {
  const sim = new SimWorld();
  const sys = new CollapseSystem({ store, waveDelayS: 0.01, settleS: 0.3 });
  const parts = HOUSE.slice(0, opts.layout ?? HOUSE.length);
  const visuals = parts.map((h) => entity(sim, [h.pos[0] - OFFSET[0], h.pos[1] - OFFSET[1], h.pos[2] - OFFSET[2]]));
  const southCol = entity(sim, HOUSE[2]!.pos, HOUSE[2]!.size);
  const doorCol = entity(sim, HOUSE[6]!.pos, HOUSE[6]!.size);
  // Wire ids taken now: a freed slot is reused at once, so an entity id alone cannot say whether its entity is gone.
  const wires = { south: sim.wireId(southCol), door: sim.wireId(doorCol) };
  if (opts.breakSouthFirst) sim.despawn(visuals[2]!); // the break system re-applied the break before the scene registered
  const specs: CollapsePartSpec[] = visuals.map((eid, i) => ({ eid, colliders: i === 2 ? [southCol] : i === 6 ? [doorCol] : [], part: parts[i]!, offset: OFFSET }));
  sys.registerBuilding(sim, "t/house-1", specs);
  const run = (s: number): void => {
    for (let t = 0; t < s; t += DT) sys.step(sim, DT);
  };
  return { sim, sys, visuals, wires, run };
}

/** Static hidden carriers (a body with the hidden asset) near height `y`. */
function carriersNear(sim: SimWorld, y: number): number {
  let n = 0;
  for (let e = 0; e <= sim.maxSlotSeen; e++) {
    if (sim.resolveWireId(sim.wireId(e)) < 0 || !hasComponent(sim.ecs, BodyConfig, e) || !hasComponent(sim.ecs, AssetRef, e)) continue;
    if (BodyConfig.motionType[e] === MotionType.Static && Math.abs(Transform.py[e]! - y) < 1e-3) n++;
  }
  return n;
}

describe("collapse persistence", () => {
  it("saves a part that came to rest, and puts it back where it lay after a restart", () => {
    const store = new SqlitePlacesStore(new Database(":memory:"));
    const a = boot(store);
    // The south wall breaks (the break system removes it): the door loses its support and falls.
    a.sim.despawn(a.visuals[2]!);
    a.sys.partBroken(a.sim, a.visuals[2]!);
    for (let t = 0; t < 1; t += DT) {
      a.sys.step(a.sim, DT);
      const c = a.sys.carrierOf(a.sim.wireId(a.visuals[6]!));
      if (c !== undefined) Velocity.ly[a.sim.resolveWireId(c)] = -3;
    }
    const falling = a.sim.resolveWireId(a.sys.carrierOf(a.sim.wireId(a.visuals[6]!))!);
    Velocity.ly[falling] = 0;
    Transform.py[falling] = 0.55;
    a.run(1);
    assert.equal(a.sys.stats.active, 0, "it came to rest");
    const rec = store.load("collapse", "t/house-1#6");
    assert.ok(rec && rec.state.startsWith("fell:"), "and was saved");
    assert.equal(rec!.respawnAt, null);

    // A restart: a fresh world, the same store. The door lies where it fell, with nothing hanging in the air.
    const b = boot(store);
    assert.ok(Math.abs(Transform.py[b.visuals[6]!]! - (0.55 + 0.2)) < 1e-3, "the door model rests where it lay");
    assert.equal(b.sim.resolveWireId(b.wires.door), -1, "its collider is gone");
    assert.equal(carriersNear(b.sim, 0.55), 1, "rubble lies there");
    b.run(2);
    assert.deepEqual([b.sys.stats.queued, b.sys.stats.active], [0, 0], "nothing falls that did not fall before");
    assert.ok(b.sim.resolveWireId(b.wires.south) >= 0, "and the standing south wall is untouched");
  });

  it("treats a part whose visual is already gone as broken: its collider goes and what it held falls", () => {
    const store = new SqlitePlacesStore(new Database(":memory:"));
    const b = boot(store, { breakSouthFirst: true });
    assert.equal(b.sim.resolveWireId(b.wires.south), -1, "the broken wall's collider is removed at boot");
    b.sys.step(b.sim, DT);
    assert.equal(b.sys.stats.queued, 1, "the door lost its support");
  });

  it("ignores a record from another layout of the building, and clears it", () => {
    const store = new SqlitePlacesStore(new Database(":memory:"));
    store.save({ kind: "collapse", key: "t/house-1#6", state: `fell:${JSON.stringify({ n: 99, pose: { px: 0, py: 0.55, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } })}`, at: 1, respawnAt: null });
    const b = boot(store);
    assert.ok(Math.abs(Transform.py[b.visuals[6]!]! - (HOUSE[6]!.pos[1] - OFFSET[1])) < 1e-6, "the door stays where it was built");
    assert.equal(store.load("collapse", "t/house-1#6"), undefined);
    b.run(1);
    assert.equal(b.sys.stats.fallen, 0);
  });

  it("is a no-op without a store", () => {
    const sim = new SimWorld();
    const sys = new CollapseSystem();
    const visuals = HOUSE.map((h) => entity(sim, h.pos));
    sys.registerBuilding(sim, "x", visuals.map((eid, i) => ({ eid, colliders: [], part: HOUSE[i]! })));
    sys.step(sim, DT);
    assert.equal(sys.stats.fallen, 0);
  });
});
