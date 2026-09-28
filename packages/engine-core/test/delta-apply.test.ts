import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import {
  Health,
  PlayerIntent,
  SimWorld,
  Transform,
  Velocity,
  applyDelta,
  collectDeltaState,
  collectFullState,
  compareStates,
  decodeDelta,
  decodeSnapshot,
  DeltaTracker,
  encodeDelta,
  encodeSnapshot,
  stateFromCollected,
} from "../src/index.js";
import type { WorldState } from "../src/index.js";

test("delta chain exactly reproduces the next state (scripted scenario)", () => {
  const sim = new SimWorld();
  const mover = sim.spawn();
  addComponent(sim.ecs, Transform, mover);
  addComponent(sim.ecs, Velocity, mover);
  Velocity.lx[mover] = 2;

  const player = sim.spawn();
  addComponent(sim.ecs, Transform, player);
  addComponent(sim.ecs, Velocity, player);
  addComponent(sim.ecs, PlayerIntent, player);
  addComponent(sim.ecs, Health, player);
  Health.current[player] = 100; Health.max[player] = 100;

  const prop = sim.spawn();
  addComponent(sim.ecs, Transform, prop);
  Transform.px[prop] = 99;
  const propWid = sim.wireId(prop); // capture before tick 3 despawns it

  const tracker = new DeltaTracker();
  const state: WorldState = stateFromCollected(
    decodeSnapshot(encodeSnapshot(collectFullState(sim, 0))),
  );
  tracker.commit(sim);
  sim.endTick();

  const dt = 1 / 30;
  for (let tick = 1; tick <= 5; tick++) {
    sim.beginTick();
    // scripted "gameplay": intent drives the player, mover drifts,
    // player takes damage, prop despawns at tick 3, newcomer at tick 4
    PlayerIntent.mx[player] = 1;
    Velocity.lx[player] = 6;
    Transform.px[mover] += Velocity.lx[mover] * dt;
    Transform.px[player] += Velocity.lx[player] * dt;
    Health.current[player] -= 7;
    if (tick === 3) sim.despawn(prop);
    if (tick === 4) {
      const late = sim.spawn();
      addComponent(sim.ecs, Transform, late);
      Transform.px[late] = -5;
    }
    const delta = decodeDelta(
      encodeDelta(collectDeltaState(sim, tick, tick - 1, tracker)),
    );
    tracker.commit(sim);
    sim.endTick();
    applyDelta(state, delta);
  }

  const expected = stateFromCollected(
    decodeSnapshot(encodeSnapshot(collectFullState(sim, 5))),
  );
  const cmp = compareStates(state, expected);
  assert.ok(cmp.equal, cmp.diffs.join("\n"));
  // prop is gone, newcomer present
  assert.equal(state.size, 3);
  assert.ok(!state.has(propWid));
});

test("compareStates reports exact diffs", () => {
  const sim = new SimWorld();
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  Transform.px[eid] = 1;
  const a = stateFromCollected(collectFullState(sim, 0));
  Transform.px[eid] = 2;
  const b = stateFromCollected(collectFullState(sim, 0));
  const cmp = compareStates(a, b);
  assert.ok(!cmp.equal);
  assert.ok(cmp.diffs.some((d) => d.includes("transform.px")));
  assert.ok(compareStates(a, a).equal);
});

test("applyDelta upserts entities it has never seen", () => {
  const sim = new SimWorld();
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, Health, eid);
  Transform.px[eid] = 3;
  Health.current[eid] = 11; Health.max[eid] = 22;

  const empty: WorldState = new Map();
  const delta = decodeDelta(
    encodeDelta(collectDeltaState(sim, 1, 0, new DeltaTracker())),
  );
  applyDelta(empty, delta);
  const cmp = compareStates(empty, stateFromCollected(collectFullState(sim, 1)));
  assert.ok(cmp.equal, cmp.diffs.join("\n"));
});

test("applyDelta removes despawned entities", () => {
  const sim = new SimWorld();
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  const wid = sim.wireId(eid);
  const tracker = new DeltaTracker();
  const state = stateFromCollected(
    decodeSnapshot(encodeSnapshot(collectFullState(sim, 0))),
  );
  tracker.commit(sim);
  sim.endTick();

  sim.despawn(eid);
  const delta = decodeDelta(encodeDelta(collectDeltaState(sim, 1, 0, tracker)));
  applyDelta(state, delta);
  assert.ok(!state.has(wid));
  assert.equal(state.size, 0);
});
