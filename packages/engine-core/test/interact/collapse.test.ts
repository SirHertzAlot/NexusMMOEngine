/**
 * CollapseSystem (DE4): a broken part drops what it held up, within caps, and the parts freeze again where they land.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent, hasComponent } from "bitecs";
import type { SupportPart } from "@mmo-engine/placement";
import { BodyConfig, MotionType, Transform, Velocity } from "../../src/components.js";
import { CollapseSystem, type CollapsePartSpec } from "../../src/interact/collapse.js";
import { SimWorld } from "../../src/world.js";

const DT = 1 / 30;

/** A static box body entity standing where `part` says. */
function put(sim: SimWorld, part: SupportPart, collider = false): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  Transform.px[eid] = part.pos[0];
  Transform.py[eid] = part.pos[1];
  Transform.pz[eid] = part.pos[2];
  Transform.qw[eid] = 1;
  Transform.sx[eid] = Transform.sy[eid] = Transform.sz[eid] = 1;
  addComponent(sim.ecs, Velocity, eid);
  addComponent(sim.ecs, BodyConfig, eid);
  const B = BodyConfig;
  B.shapeKind[eid] = 0;
  B.halfX[eid] = part.size[0] / 2;
  B.halfY[eid] = part.size[1] / 2;
  B.halfZ[eid] = part.size[2] / 2;
  B.motionType[eid] = MotionType.Static;
  B.layer[eid] = 0;
  B.friction[eid] = 0.8;
  if (collider) B.mass[eid] = 0;
  return eid;
}

const p = (category: string, pos: [number, number, number], size: [number, number, number]): SupportPart => ({ pos, size, yawDeg: 0, category, id: category });

// 0 floor, 1 north, 2 south, 3 east, 4 west walls, 5 roof, 6 door (on the south wall)
const HOUSE: SupportPart[] = [
  p("floor", [0, 0.15, 0], [6, 0.3, 6]),
  p("wall", [0, 1.8, -2.9], [6, 3, 0.2]),
  p("wall", [0, 1.8, 2.9], [6, 3, 0.2]),
  p("wall", [2.9, 1.8, 0], [0.2, 3, 6]),
  p("wall", [-2.9, 1.8, 0], [0.2, 3, 6]),
  p("roof", [0, 3.45, 0], [6.4, 0.3, 6.4]),
  p("door", [0, 1.6, 2.9], [1, 2.2, 0.3]),
];

function build(opts: ConstructorParameters<typeof CollapseSystem>[0] = {}) {
  const sim = new SimWorld();
  const sys = new CollapseSystem(opts);
  const eids = HOUSE.map((h) => put(sim, h));
  // The south wall has a separate collider entity, as the synthesized buildings do.
  const wallCollider = put(sim, HOUSE[2]!, true);
  const specs: CollapsePartSpec[] = eids.map((eid, i) => ({ eid, colliders: i === 2 ? [wallCollider] : [], part: HOUSE[i]! }));
  sys.registerBuilding(sim, "house-1", specs);
  const run = (seconds: number): void => {
    for (let t = 0; t < seconds; t += DT) sys.step(sim, DT);
  };
  return { sim, sys, eids, wallCollider, run };
}

const motion = (sim: SimWorld, eid: number): number | null => (hasComponent(sim.ecs, BodyConfig, eid) ? BodyConfig.motionType[eid]! : null);

describe("CollapseSystem", () => {
  it("leaves everything static until a part breaks", () => {
    const { sim, sys, eids, run } = build();
    run(2);
    assert.deepEqual(eids.map((e) => motion(sim, e)), eids.map(() => MotionType.Static));
    assert.deepEqual(sys.stats, { queued: 0, active: 0, fallen: 0, buildings: 1 });
  });

  it("breaking a wall that holds nothing up drops only what hung from it", () => {
    const { sim, sys, eids, run } = build();
    assert.equal(sys.partBroken(sim, eids[2]!), 1, "the door");
    run(1);
    assert.equal(motion(sim, eids[6]!), MotionType.Dynamic);
    assert.equal(motion(sim, eids[5]!), MotionType.Static, "the roof still spans the other walls");
  });

  it("takes the body off for a tick, then puts it back dynamic with a mass; physics sees it as a new body", () => {
    const { sim, sys, eids, run } = build();
    sys.partBroken(sim, eids[2]!);
    // The door is due after one wave delay: step until its body comes off.
    let off = false;
    let on = false;
    for (let i = 0; i < 60 && !on; i++) {
      sys.step(sim, DT);
      const m = motion(sim, eids[6]!);
      if (m === null) off = true;
      else if (off) on = m === MotionType.Dynamic;
    }
    assert.ok(off && on, "off for a tick, then on dynamic");
    assert.ok(BodyConfig.mass[eids[6]!]! >= 5);
    assert.equal(BodyConfig.layer[eids[6]!], 1);
    run(0);
  });

  it("removes a falling part's collider entities", () => {
    const { sim, sys, eids, wallCollider, run } = build();
    const wid = sim.wireId(wallCollider);
    assert.ok(sim.resolveWireId(wid) >= 0);
    sys.partBroken(sim, eids[0]!); // the floor: everything falls
    run(1);
    assert.ok(sys.stats.fallen >= 4);
    assert.equal(sim.resolveWireId(wid), -1, "the south wall's collider went with it");
  });

  it("brings a building down in waves: walls first, then the roof", () => {
    const { sim, sys, eids, run } = build({ waveDelayS: 1 });
    sys.partBroken(sim, eids[0]!);
    run(0.5);
    assert.equal(sys.stats.fallen, 0, "the first wave is a delay away");
    run(1);
    assert.equal(motion(sim, eids[1]!) === null || motion(sim, eids[1]!) === MotionType.Dynamic, true);
    assert.equal(motion(sim, eids[5]!), MotionType.Static, "the roof waits for the second wave");
    run(1.5);
    assert.ok(sys.stats.fallen >= 6);
  });

  it("never has more parts dynamic than the cap, and releases the rest as others settle", () => {
    const { sim, sys, eids, run } = build({ maxActive: 2, perTick: 8, waveDelayS: 0.01, settleS: 0.2 });
    sys.partBroken(sim, eids[0]!);
    let peak = 0;
    for (let t = 0; t < 8; t += DT) {
      sys.step(sim, DT);
      peak = Math.max(peak, sys.stats.active);
      // Everything dynamic is at rest at once (no physics here): it freezes and makes room.
      for (const e of eids) if (hasComponent(sim.ecs, BodyConfig, e) && BodyConfig.motionType[e] === MotionType.Dynamic) Velocity.lx[e] = Velocity.ly[e] = Velocity.lz[e] = 0;
    }
    assert.ok(peak <= 2, `peak ${peak}`);
    assert.equal(sys.stats.fallen, 6, "all of it came down in the end");
    assert.equal(sys.stats.queued, 0);
    run(0);
  });

  it("releases at most perTick parts in a tick", () => {
    const { sim, sys, eids } = build({ perTick: 2, waveDelayS: 0.001 });
    sys.partBroken(sim, eids[0]!);
    sys.step(sim, DT);
    assert.equal(sys.stats.fallen, 2);
    sys.step(sim, DT);
    assert.equal(sys.stats.fallen, 4);
  });

  it("freezes a part where it came to rest, static again, with no speed", () => {
    const { sim, sys, eids } = build({ settleS: 0.5, waveDelayS: 0.01 });
    sys.partBroken(sim, eids[2]!);
    const door = eids[6]!;
    for (let t = 0; t < 1; t += DT) {
      sys.step(sim, DT); // the door falls (physics would be giving it speed)
      if (motion(sim, door) === MotionType.Dynamic) Velocity.ly[door] = -3;
    }
    assert.equal(motion(sim, door), MotionType.Dynamic);
    Velocity.ly[door] = 0;
    for (let t = 0; t < 2; t += DT) sys.step(sim, DT);
    assert.equal(motion(sim, door), MotionType.Static);
    assert.equal(BodyConfig.layer[door], 0);
    assert.equal(sys.stats.active, 0);
  });

  it("freezes a part that is still moving after maxAgeS", () => {
    const { sim, sys, eids } = build({ maxAgeS: 1, waveDelayS: 0.01 });
    sys.partBroken(sim, eids[2]!);
    const door = eids[6]!;
    for (let t = 0; t < 3; t += DT) {
      sys.step(sim, DT);
      if (motion(sim, door) === MotionType.Dynamic) Velocity.ly[door] = -5;
    }
    assert.equal(motion(sim, door), MotionType.Static);
  });

  it("ignores a part it does not know, and a part reported twice falls once", () => {
    const { sim, sys, eids } = build();
    assert.equal(sys.partBroken(sim, 9999), 0);
    assert.equal(sys.partBroken(sim, eids[2]!), 1);
    assert.equal(sys.partBroken(sim, eids[2]!), 0);
  });

  it("skips a part that was despawned meanwhile", () => {
    const { sim, sys, eids, run } = build();
    sys.partBroken(sim, eids[2]!);
    sim.despawn(eids[6]!);
    run(1);
    assert.equal(sys.stats.fallen, 0);
  });
});
