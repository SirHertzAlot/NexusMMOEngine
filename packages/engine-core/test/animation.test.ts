/**
 * TDD: EA21 foundation — server-side animation clip state.
 *
 * The server decides *which* clip plays and *when* it started; the client
 * renders bone matrices. The Animation component carries (clipId,
 * startTick, rate, layerMask) — a few bytes per change, never bone data.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { AnimationSystem, ensureAnimation } from "../src/animation.js";
import { ClipId, Move } from "@mmo-engine/protocol";

function animatedWorld(): { sim: SimWorld; eid: number } {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const eid = sim.spawn();
  ensureAnimation(sim, eid);
  return { sim, eid };
}

describe("AnimationSystem", () => {
  it("sets the attack clip when a character attacks", () => {
    const { sim, eid } = animatedWorld();
    addComponent(sim.ecs, C.Action, eid);
    C.Action.move[eid] = Move.SwordA;
    C.Action.started[eid] = 100;
    const anim = new AnimationSystem();
    sim.beginTick(100);
    anim.step(sim, 1 / 30);
    sim.endTick();
    assert.equal(C.Animation.clipId[eid], ClipId.AttackSwordA);
  });

  it("sets the walk clip when moving, idle when still", () => {
    const { sim, eid } = animatedWorld();
    addComponent(sim.ecs, C.Velocity, eid);
    C.Velocity.lx[eid] = 3;
    C.Velocity.lz[eid] = 0;
    const anim = new AnimationSystem();
    sim.beginTick(100);
    anim.step(sim, 1 / 30);
    sim.endTick();
    assert.equal(C.Animation.clipId[eid], ClipId.Walk);
    // Stop.
    C.Velocity.lx[eid] = 0;
    sim.beginTick(101);
    anim.step(sim, 1 / 30);
    sim.endTick();
    assert.equal(C.Animation.clipId[eid], ClipId.Idle);
  });

  it("records the move's start tick for attacks", () => {
    const { sim, eid } = animatedWorld();
    addComponent(sim.ecs, C.Action, eid);
    C.Action.move[eid] = Move.SwordA;
    C.Action.started[eid] = 42;
    const anim = new AnimationSystem();
    sim.beginTick(100);
    anim.step(sim, 1 / 30);
    sim.endTick();
    assert.equal(C.Animation.startTick[eid], 42);
    assert.ok(C.Animation.rate[eid] > 0);
  });

  it("does not restart the clip every tick", () => {
    const { sim, eid } = animatedWorld();
    addComponent(sim.ecs, C.Action, eid);
    C.Action.move[eid] = Move.SwordA;
    C.Action.started[eid] = 100;
    const anim = new AnimationSystem();
    sim.beginTick(100);
    anim.step(sim, 1 / 30);
    sim.endTick();
    const first = C.Animation.startTick[eid];
    sim.beginTick(101);
    anim.step(sim, 1 / 30);
    sim.endTick();
    assert.equal(C.Animation.startTick[eid], first);
  });

  it("combat moves take priority over locomotion", () => {
    const { sim, eid } = animatedWorld();
    addComponent(sim.ecs, C.Action, eid);
    addComponent(sim.ecs, C.Velocity, eid);
    C.Action.move[eid] = Move.Guard;
    C.Action.started[eid] = 100;
    C.Velocity.lx[eid] = 5; // sprinting speed
    const anim = new AnimationSystem();
    sim.beginTick(100);
    anim.step(sim, 1 / 30);
    sim.endTick();
    assert.equal(C.Animation.clipId[eid], ClipId.Block);
  });
});
