/**
 * CrowdSystem against the real DetourCrowd addon, through the systems a
 * player's input takes (IntentSystem, IntegrateSystem): a character with
 * a NavAgent target walks the navmesh round a wall to it, gives a
 * standing player room, stops when its target is cleared, and leaves the
 * crowd when it despawns. Characters without a NavAgent are agents too
 * (obstacles) but are never steered.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  CrowdSystem,
  createNavigationBackend,
  IntegrateSystem,
  IntentSystem,
  Locomotion,
  NavAgent,
  NavAgentState,
  PlayerIntent,
  SimWorld,
  Transform,
  Velocity,
  type NavigationBackend,
} from "../../src/index.js";

const DT = 1 / 30;

/** Flat rectangles at y=0, counter-clockwise from above. */
function rects(list: Array<[number, number, number, number]>): { verts: Float32Array; idx: Uint32Array } {
  const verts: number[] = [];
  const idx: number[] = [];
  for (const [x0, x1, z0, z1] of list) {
    const b = verts.length / 3;
    verts.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  return { verts: new Float32Array(verts), idx: new Uint32Array(idx) };
}

function navWorld(list: Array<[number, number, number, number]>): NavigationBackend {
  const backend = createNavigationBackend({
    originX: 0, originZ: 0, tileWorldSize: 20,
    profiles: [{ id: 0, agentHeight: 2, agentRadius: 0.35, agentMaxClimb: 0.9 }],
  });
  const { verts, idx } = rects(list);
  const { blob } = backend.bakeTile({
    tileX: 0, tileZ: 0, cellSize: 0.2, cellHeight: 0.2, agentHeight: 2, agentRadius: 0.35, agentMaxClimb: 0.9,
    walkableSlopeAngle: 45, regionMinSize: 2, regionMergeSize: 20, edgeMaxLen: 12, edgeMaxError: 1.3,
    vertsPerPoly: 6, detailSampleDist: 6, detailSampleMaxError: 1,
  }, verts, idx);
  backend.loadTiles([blob]);
  return backend;
}

function character(sim: SimWorld, x: number, z: number): number {
  const e = sim.spawn();
  for (const c of [Transform, Velocity, PlayerIntent, Locomotion]) addComponent(sim.ecs, c, e);
  Transform.px[e] = x;
  Transform.pz[e] = z;
  Transform.qw[e] = 1;
  return e;
}

function walker(sim: SimWorld, x: number, z: number, speed = 3): number {
  const e = character(sim, x, z);
  addComponent(sim.ecs, NavAgent, e);
  NavAgent.speed[e] = speed;
  NavAgent.tx[e] = NaN;
  return e;
}

function goTo(e: number, x: number, z: number): void {
  NavAgent.tx[e] = x;
  NavAgent.ty[e] = 0;
  NavAgent.tz[e] = z;
  NavAgent.seq[e]++;
}

/** The tick a player's input takes, with the crowd writing the intent first. */
function tick(sim: SimWorld, crowd: CrowdSystem, others: number[] = []): void {
  for (const e of others) {
    PlayerIntent.mx[e] = 0;
    PlayerIntent.mz[e] = 0;
  }
  crowd.step(sim, DT);
  new IntentSystem().step(sim, DT);
  new IntegrateSystem().step(sim, DT);
}

describe("CrowdSystem (DetourCrowd)", () => {
  it("walks a character round a wall to its target, through the ordinary movement systems", () => {
    // A U: the middle column (x 8-12, z > 6) is a wall.
    const nav = navWorld([[0, 8, 0, 20], [12, 20, 0, 20], [8, 12, 0, 6]]);
    const sim = new SimWorld();
    const crowd = new CrowdSystem(nav.crowd!);
    const e = walker(sim, 4, 16);
    tick(sim, crowd);
    goTo(e, 16, 16);
    let lowest = Infinity;
    for (let i = 0; i < 30 * 20 && NavAgent.state[e] !== NavAgentState.Arrived; i++) {
      tick(sim, crowd);
      lowest = Math.min(lowest, Transform.pz[e]);
      assert.ok(!(Transform.px[e] > 8.4 && Transform.px[e] < 11.6 && Transform.pz[e] > 6.4), `never through the wall (${Transform.px[e]}, ${Transform.pz[e]})`);
    }
    assert.equal(NavAgent.state[e], NavAgentState.Arrived);
    assert.ok(Math.hypot(Transform.px[e] - 16, Transform.pz[e] - 16) < 0.6);
    assert.ok(lowest < 6.5, "it went round, below the wall");
    nav.destroy();
  });

  it("gives a standing player room, and never steers them", () => {
    const nav = navWorld([[0, 20, 0, 20]]);
    const sim = new SimWorld();
    const crowd = new CrowdSystem(nav.crowd!);
    const player = character(sim, 10, 10);
    const e = walker(sim, 2, 10);
    tick(sim, crowd, [player]);
    goTo(e, 18, 10);
    let closest = Infinity;
    for (let i = 0; i < 30 * 10; i++) {
      tick(sim, crowd, [player]);
      closest = Math.min(closest, Math.hypot(Transform.px[e] - Transform.px[player], Transform.pz[e] - Transform.pz[player]));
    }
    assert.equal(crowd.agentCount, 2, "the player is an agent too");
    assert.ok(closest > 0.5, `kept clear of the player (closest ${closest.toFixed(2)} m)`);
    assert.equal(NavAgent.state[e], NavAgentState.Arrived);
    assert.equal(Transform.px[player], 10, "the player wasn't moved");
    assert.equal(Transform.pz[player], 10);
    nav.destroy();
  });

  it("stops when the target is cleared, and leaves the crowd on despawn", () => {
    const nav = navWorld([[0, 20, 0, 20]]);
    const sim = new SimWorld();
    const crowd = new CrowdSystem(nav.crowd!);
    const e = walker(sim, 2, 2);
    tick(sim, crowd);
    goTo(e, 18, 18);
    for (let i = 0; i < 20; i++) tick(sim, crowd);
    assert.equal(NavAgent.state[e], NavAgentState.Moving);
    NavAgent.tx[e] = NaN;
    NavAgent.seq[e]++;
    for (let i = 0; i < 20; i++) tick(sim, crowd);
    assert.equal(NavAgent.state[e], NavAgentState.Idle);
    const x = Transform.px[e];
    tick(sim, crowd);
    assert.ok(Math.abs(Transform.px[e] - x) < 1e-3, "standing still");
    sim.despawn(e);
    tick(sim, crowd);
    assert.equal(crowd.agentCount, 0);
    assert.equal(nav.crowd!.count(), 0);
    nav.destroy();
  });

  it("reports Invalid off the navmesh, so a brain can fall back to walking straight", () => {
    const nav = navWorld([[0, 20, 0, 20]]);
    const sim = new SimWorld();
    const crowd = new CrowdSystem(nav.crowd!);
    const e = walker(sim, 60, 60);
    goTo(e, 10, 10);
    tick(sim, crowd);
    assert.equal(NavAgent.state[e], NavAgentState.Invalid);
    assert.equal(PlayerIntent.mx[e], 0, "no steering from the crowd there");
    nav.destroy();
  });
});
