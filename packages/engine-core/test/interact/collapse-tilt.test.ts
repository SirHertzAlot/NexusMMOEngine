/**
 * A tilted part (a beam laid on its side) falls in its box's frame: the carrier keeps the part's yaw, and the model is
 * drawn turned by its tilt within the carrier wherever the carrier goes.
 */

import { it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import type { SupportPart } from "@mmo-engine/placement";
import { Transform } from "../../src/components.js";
import { CollapseSystem } from "../../src/interact/collapse.js";
import { SimWorld } from "../../src/world.js";

const DT = 1 / 30;
const s = Math.SQRT1_2;
const TILT = [0, 0, s, s] as const; // 90 degrees about Z

const p = (category: string, pos: [number, number, number], size: [number, number, number]): SupportPart => ({ pos, size, yawDeg: 0, category, id: category });
// A floor, a wall, and a beam resting on the wall's top.
const PARTS: SupportPart[] = [p("floor", [0, 0.15, 0], [6, 0.3, 6]), p("wall", [0, 1.8, 0], [6, 3, 0.2]), p("beam", [0, 3.4, 0], [4, 0.2, 0.2])];

const quat = (e: number): number[] => [Transform.qx[e]!, Transform.qy[e]!, Transform.qz[e]!, Transform.qw[e]!];
const near = (a: readonly number[], b: readonly number[]): boolean => a.every((v, i) => Math.abs(v - b[i]!) < 1e-4);

it("a tilted part falls in its box's frame and is drawn tilted in it", () => {
  const sim = new SimWorld();
  const sys = new CollapseSystem({ waveDelayS: 0.01, settleS: 5 });
  const visuals = PARTS.map((part) => {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    [Transform.px[e], Transform.py[e], Transform.pz[e]] = part.pos;
    Transform.qw[e] = 1;
    Transform.sx[e] = Transform.sy[e] = Transform.sz[e] = 1;
    return e;
  });
  const beam = visuals[2]!;
  [Transform.qx[beam], Transform.qy[beam], Transform.qz[beam], Transform.qw[beam]] = TILT; // drawn tilted, as spawned
  sys.registerBuilding(sim, "t", visuals.map((eid, i) => ({ eid, colliders: [], part: PARTS[i]!, ...(i === 2 ? { tilt: TILT } : {}) })));

  sim.despawn(visuals[1]!);
  sys.partBroken(sim, visuals[1]!);
  for (let t = 0; t < 0.2; t += DT) sys.step(sim, DT);
  const carrier = sim.resolveWireId(sys.carrierOf(sim.wireId(beam))!);
  assert.ok(carrier >= 0, "the beam fell");
  assert.ok(near(quat(carrier), [0, 0, 0, 1]), `the carrier is the box, with the part's yaw only: ${quat(carrier)}`);

  // The body turns a quarter about +Y as it tumbles: the model turns with it, still tilted within it.
  [Transform.qx[carrier], Transform.qy[carrier], Transform.qz[carrier], Transform.qw[carrier]] = [0, s, 0, s];
  sys.step(sim, DT);
  assert.ok(near(quat(beam), [0.5, 0.5, 0.5, 0.5]), `drawn as the carrier's turn then its tilt: ${quat(beam)}`);
});
