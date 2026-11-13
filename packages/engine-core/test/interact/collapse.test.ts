/**
 * CollapseSystem (DE4): a broken part drops what it held up, within caps. A part is a body-less visual entity plus
 * collider entities; falling gives it a dynamic carrier at the model's middle, the visual follows, and at rest the
 * carrier is replaced by a static one where it lies.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent, hasComponent } from "bitecs";
import type { SupportPart } from "@mmo-engine/placement";
import { AssetRef, BodyConfig, MotionType, Transform, Velocity } from "../../src/components.js";
import { CollapseSystem, type CollapsePartSpec } from "../../src/interact/collapse.js";
import { SimWorld } from "../../src/world.js";

const DT = 1 / 30;

/** The model entity: a transform at its pivot, no body. */
function visual(sim: SimWorld, pos: readonly [number, number, number]): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  Transform.px[eid] = pos[0];
  Transform.py[eid] = pos[1];
  Transform.pz[eid] = pos[2];
  Transform.qw[eid] = 1;
  Transform.sx[eid] = Transform.sy[eid] = Transform.sz[eid] = 1;
  return eid;
}

/** A static box collider entity round `part`. */
function collider(sim: SimWorld, part: SupportPart): number {
  const eid = visual(sim, part.pos);
  addComponent(sim.ecs, Velocity, eid);
  addComponent(sim.ecs, BodyConfig, eid);
  const B = BodyConfig;
  B.shapeKind[eid] = 0;
  B.halfX[eid] = part.size[0] / 2;
  B.halfY[eid] = part.size[1] / 2;
  B.halfZ[eid] = part.size[2] / 2;
  B.motionType[eid] = MotionType.Static;
  return eid;
}

const p = (category: string, pos: [number, number, number], size: [number, number, number]): SupportPart => ({ pos, size, yawDeg: 0, category, id: category });

// 0 floor, 1 north, 2 south, 3 east, 4 west walls, 5 roof, 6 door (on the south wall); each part's pivot is offset
// from the middle of its model, like a model pivoted at one end.
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

function build(opts: ConstructorParameters<typeof CollapseSystem>[0] = {}) {
  const sim = new SimWorld();
  const sys = new CollapseSystem(opts);
  const visuals = HOUSE.map((h) => visual(sim, [h.pos[0] - OFFSET[0], h.pos[1] - OFFSET[1], h.pos[2] - OFFSET[2]]));
  // The south wall has a collider entity, as the synthesized buildings do; the floor has none.
  const wallCollider = collider(sim, HOUSE[2]!);
  const specs: CollapsePartSpec[] = visuals.map((eid, i) => ({ eid, colliders: i === 2 ? [wallCollider] : [], part: HOUSE[i]!, offset: OFFSET }));
  sys.registerBuilding(sim, "house-1", specs);
  const run = (seconds: number): void => {
    for (let t = 0; t < seconds; t += DT) sys.step(sim, DT);
  };
  const carrier = (v: number): number => {
    const w = sys.carrierOf(sim.wireId(v));
    return w === undefined ? -1 : sim.resolveWireId(w);
  };
  return { sim, sys, visuals, wallCollider, run, carrier };
}

/** Entities that are static carriers (a body with the hidden collider asset) at height `y`. */
function staticAt(sim: SimWorld, y: number): number {
  let n = 0;
  for (let e = 0; e <= sim.maxSlotSeen; e++) {
    if (sim.resolveWireId(sim.wireId(e)) < 0 || !hasComponent(sim.ecs, BodyConfig, e) || !hasComponent(sim.ecs, AssetRef, e)) continue;
    if (BodyConfig.motionType[e] === MotionType.Static && Math.abs(Transform.py[e]! - y) < 1e-5) n++;
  }
  return n;
}

describe("CollapseSystem", () => {
  it("does nothing until a part breaks", () => {
    const { sys, run } = build();
    run(2);
    assert.deepEqual(sys.stats, { queued: 0, active: 0, fallen: 0, buildings: 1 });
  });

  it("breaking the south wall drops only what hung from it, and takes its collider", () => {
    const { sim, sys, visuals, wallCollider, run, carrier } = build();
    const cw = sim.wireId(wallCollider);
    assert.equal(sys.partBroken(sim, visuals[2]!), 1, "the door");
    assert.equal(sim.resolveWireId(cw), -1, "the broken wall's collider is gone at once");
    run(1);
    assert.ok(carrier(visuals[6]!) >= 0, "the door has a carrier");
    assert.equal(carrier(visuals[5]!), -1, "the roof still spans the other walls");
  });

  it("gives a falling part a dynamic carrier at the middle of its model, hidden like a collider, with a mass", () => {
    const { sim, sys, visuals, run, carrier } = build({ waveDelayS: 0.01 });
    sys.partBroken(sim, visuals[2]!);
    run(0.2);
    const c = carrier(visuals[6]!);
    assert.ok(c >= 0);
    assert.equal(BodyConfig.motionType[c], MotionType.Dynamic);
    assert.equal(BodyConfig.layer[c], 1);
    assert.ok(BodyConfig.mass[c]! >= 5);
    assert.ok(hasComponent(sim.ecs, AssetRef, c));
    assert.deepEqual([Transform.px[c], Transform.py[c], Transform.pz[c]], [...HOUSE[6]!.pos].map(Math.fround));
    assert.deepEqual([BodyConfig.halfX[c], BodyConfig.halfY[c], BodyConfig.halfZ[c]], [0.5, 1.1, 0.15].map(Math.fround));
  });

  it("moves the visual with its carrier, less the pivot offset turned with it", () => {
    const { sim, sys, visuals, run, carrier } = build({ waveDelayS: 0.01 });
    sys.partBroken(sim, visuals[2]!);
    run(0.2);
    const v = visuals[6]!;
    const c = carrier(v);
    // Physics would move the carrier: drop it 1 m and turn it a quarter turn about y.
    Transform.py[c] = Transform.py[c]! - 1;
    Transform.qy[c] = Math.sin(Math.PI / 4);
    Transform.qw[c] = Math.cos(Math.PI / 4);
    sys.step(sim, DT);
    // offset (0.5, -0.2, 0) turned a quarter about y is (0, -0.2, -0.5): the visual stands that far from the middle.
    assert.ok(Math.abs(Transform.px[v]! - Transform.px[c]!) < 1e-4);
    assert.ok(Math.abs(Transform.py[v]! - (Transform.py[c]! + 0.2)) < 1e-4);
    assert.ok(Math.abs(Transform.pz[v]! - (Transform.pz[c]! + 0.5)) < 1e-4);
    assert.ok(Math.abs(Transform.qy[v]! - Transform.qy[c]!) < 1e-6 && Math.abs(Transform.qw[v]! - Transform.qw[c]!) < 1e-6);
  });

  it("brings a building down in waves", () => {
    const { sim, sys, visuals, run, carrier } = build({ waveDelayS: 1 });
    sys.partBroken(sim, visuals[0]!);
    run(0.5);
    assert.equal(sys.stats.fallen, 0, "the first wave is a delay away");
    run(1);
    assert.ok(sys.stats.fallen >= 4);
    assert.equal(carrier(visuals[5]!), -1, "the roof waits for the second wave");
    run(1.5);
    assert.equal(sys.stats.fallen, 6);
  });

  it("never has more carriers dynamic than the cap, and releases the rest as others settle", () => {
    const { sim, sys, visuals } = build({ maxActive: 2, perTick: 8, waveDelayS: 0.01, settleS: 0.2 });
    sys.partBroken(sim, visuals[0]!);
    let peak = 0;
    for (let t = 0; t < 10; t += DT) {
      sys.step(sim, DT);
      peak = Math.max(peak, sys.stats.active);
      // No physics here: everything dynamic is at rest at once, so it freezes and makes room.
      for (let e = 0; e <= sim.maxSlotSeen; e++) if (hasComponent(sim.ecs, BodyConfig, e) && BodyConfig.motionType[e] === MotionType.Dynamic) Velocity.lx[e] = Velocity.ly[e] = Velocity.lz[e] = 0;
    }
    assert.ok(peak <= 2, `peak ${peak}`);
    assert.equal(sys.stats.fallen, 6, "all of it came down in the end");
    assert.equal(sys.stats.queued, 0);
  });

  it("releases at most perTick parts in a tick", () => {
    const { sim, sys, visuals } = build({ perTick: 2, waveDelayS: 0.001 });
    sys.partBroken(sim, visuals[0]!);
    sys.step(sim, DT);
    assert.equal(sys.stats.fallen, 2);
    sys.step(sim, DT);
    assert.equal(sys.stats.fallen, 4);
  });

  it("freezes a part where it came to rest: a static carrier there, the visual in its final pose", () => {
    const { sim, sys, visuals, carrier } = build({ settleS: 0.5, waveDelayS: 0.01 });
    sys.partBroken(sim, visuals[2]!);
    const door = visuals[6]!;
    for (let t = 0; t < 1; t += DT) {
      sys.step(sim, DT);
      if (carrier(door) >= 0) Velocity.ly[carrier(door)] = -3; // physics would be giving it speed
    }
    const at = carrier(door);
    assert.ok(at >= 0);
    const wid = sim.wireId(at);
    Velocity.ly[at] = 0;
    Transform.py[at] = 0.55;
    for (let t = 0; t < 2; t += DT) sys.step(sim, DT);
    assert.equal(carrier(door), -1, "no longer falling");
    assert.equal(sys.stats.active, 0);
    assert.equal(sim.resolveWireId(wid), -1, "the dynamic carrier is gone");
    assert.equal(staticAt(sim, Math.fround(0.55)), 1, "a static one lies where it was");
    assert.ok(Math.abs(Transform.py[door]! - (0.55 + 0.2)) < 1e-4, "the visual rests where the carrier does, less the pivot offset");
  });

  it("freezes a part that is still moving after maxAgeS", () => {
    const { sim, sys, visuals, carrier } = build({ maxAgeS: 1, waveDelayS: 0.01 });
    sys.partBroken(sim, visuals[2]!);
    const door = visuals[6]!;
    for (let t = 0; t < 3; t += DT) {
      sys.step(sim, DT);
      if (carrier(door) >= 0) Velocity.ly[carrier(door)] = -5;
    }
    assert.equal(carrier(door), -1);
    assert.equal(sys.stats.active, 0);
  });

  it("ignores a part it does not know, and a part reported twice falls once", () => {
    const { sim, sys, visuals } = build();
    assert.equal(sys.partBroken(sim, 9999), 0);
    assert.equal(sys.partBroken(sim, visuals[2]!), 1);
    assert.equal(sys.partBroken(sim, visuals[2]!), 0);
  });

  it("skips a part that was despawned meanwhile", () => {
    const { sim, sys, visuals, run } = build();
    sys.partBroken(sim, visuals[2]!);
    sim.despawn(visuals[6]!);
    run(1);
    assert.equal(sys.stats.fallen, 0);
  });
});
