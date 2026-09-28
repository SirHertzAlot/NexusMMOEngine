/**
 * Restored login avatars have no session (sessions and tokens are
 * in-memory only), so the server despawns them after a restore instead of
 * leaving one permanent ghost per restart. Non-avatar entities (terrain,
 * scatter) must survive untouched. (Accumulation across real restarts is
 * covered end-to-end; restoreFromState needs a fresh process because
 * bitECS entity ids are process-global.)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { addComponent, hasComponent } from "bitecs";
import {
  despawnSessionlessAvatars,
  Health,
  PlayerIntent,
  SimWorld,
  Transform,
  Velocity,
} from "../../src/index.js";

function avatar(sim: SimWorld): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, Velocity, eid);
  addComponent(sim.ecs, PlayerIntent, eid);
  addComponent(sim.ecs, Health, eid);
  return eid;
}

function prop(sim: SimWorld): number {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, Health, eid);
  return eid;
}

test("despawnSessionlessAvatars removes avatars and keeps everything else", () => {
  const sim = new SimWorld();
  const tree = prop(sim);
  avatar(sim);
  const rock = prop(sim);
  avatar(sim);
  assert.equal(sim.liveEntityCount, 4);

  assert.equal(despawnSessionlessAvatars(sim), 2);
  assert.equal(sim.liveEntityCount, 2);
  assert.ok(hasComponent(sim.ecs, Transform, tree));
  assert.ok(hasComponent(sim.ecs, Transform, rock));
  assert.equal(despawnSessionlessAvatars(sim), 0, "idempotent");
});
