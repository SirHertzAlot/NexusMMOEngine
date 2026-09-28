import test from "node:test";
import assert from "node:assert/strict";
import { addComponent, entityExists, hasComponent } from "bitecs";
import {
  makeWireEntityId,
  parseWireEntityId,
  PlayerIntent,
  SimWorld,
  Transform,
  Velocity,
} from "../src/index.js";

test("spawn issues wire ids with generation 0", () => {
  const sim = new SimWorld();
  const eid = sim.spawn();
  assert.equal(parseWireEntityId(sim.wireId(eid)).generation, 0);
  assert.equal(parseWireEntityId(sim.wireId(eid)).slot, eid);
  assert.ok(entityExists(sim.ecs, eid));
});

test("slot reuse bumps the generation (ABA guard)", () => {
  const sim = new SimWorld();
  const a = sim.spawn();
  const firstWire = sim.wireId(a);
  sim.despawn(a);
  assert.ok(!entityExists(sim.ecs, a));
  const b = sim.spawn();
  assert.equal(a, b); // eager slot recycling
  const reused = sim.wireId(b);
  assert.notEqual(firstWire, reused);
  assert.equal(parseWireEntityId(reused).generation, 1);
  assert.equal(reused, makeWireEntityId(1, b));
});

test("spawned/despawned wire ids accumulate until endTick", () => {
  const sim = new SimWorld();
  const a = sim.spawn();
  const b = sim.spawn();
  sim.despawn(a);
  assert.deepEqual([...sim.spawnedWireIds()], [sim.wireId(a), sim.wireId(b)]);
  assert.deepEqual([...sim.despawnedWireIds()], [sim.wireId(a)]);
  sim.endTick();
  assert.deepEqual([...sim.spawnedWireIds()], []);
  assert.deepEqual([...sim.despawnedWireIds()], []);
});

test("despawning a dead entity is a no-op", () => {
  const sim = new SimWorld();
  sim.despawn(999); // never existed
  assert.deepEqual([...sim.despawnedWireIds()], []);
  const a = sim.spawn();
  sim.despawn(a);
  sim.despawn(a); // double despawn
  assert.equal(sim.despawnedWireIds().length, 1);
});

test("spawned/despawned/tick events fire for subscribers", () => {
  const sim = new SimWorld();
  const seen: Array<[string, bigint | number]> = [];
  sim.events.on("spawned", (p) => seen.push(["spawned", p]));
  sim.events.on("despawned", (p) => seen.push(["despawned", p]));
  sim.events.on("tick", (p) => seen.push(["tick", p]));
  const a = sim.spawn();
  sim.despawn(a);
  sim.emitTick(7);
  assert.deepEqual(seen, [
    ["spawned", sim.wireId(a)],
    ["despawned", sim.wireId(a)],
    ["tick", 7],
  ]);
});

test("queued intents drain into PlayerIntent components at beginTick", () => {
  const sim = new SimWorld();
  const eid = sim.spawn();
  addComponent(sim.ecs, PlayerIntent, eid);
  sim.queueIntent(eid, {
    mx: 1, my: 0, mz: -1, lookYaw: 0.5, lookPitch: -0.1,
    jump: true, buttons: 3,
  });
  // Not applied until the tick starts.
  assert.equal(PlayerIntent.mx[eid], 0);
  sim.beginTick();
  assert.equal(PlayerIntent.mx[eid], 1);
  assert.equal(PlayerIntent.mz[eid], -1);
  assert.equal(PlayerIntent.lookYaw[eid], 0.5);
  // f32 store: -0.1 is not exactly representable
  assert.ok(Math.abs(PlayerIntent.lookPitch[eid] - -0.1) < 1e-6);
  assert.equal(PlayerIntent.jump[eid], 1);
  assert.equal(PlayerIntent.buttons[eid], 3);
});

test("intents for dead or intent-less entities are dropped, not crashed on", () => {
  const sim = new SimWorld();
  const plain = sim.spawn();
  addComponent(sim.ecs, Transform, plain); // no PlayerIntent
  sim.queueIntent(plain, { mx: 1, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0 });
  const doomed = sim.spawn();
  addComponent(sim.ecs, PlayerIntent, doomed);
  sim.queueIntent(doomed, { mx: 1, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0 });
  sim.despawn(doomed);
  sim.beginTick(); // must not throw
  assert.ok(!hasComponent(sim.ecs, PlayerIntent, plain));
});

test("N entities may carry PlayerIntent — no singleton player", () => {
  const sim = new SimWorld();
  const eids: number[] = [];
  for (let i = 0; i < 8; i++) {
    const eid = sim.spawn();
    addComponent(sim.ecs, PlayerIntent, eid);
    addComponent(sim.ecs, Velocity, eid);
    eids.push(eid);
    sim.queueIntent(eid, {
      mx: i, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0,
    });
  }
  sim.beginTick();
  for (let i = 0; i < 8; i++) assert.equal(PlayerIntent.mx[eids[i]], i);
});

test("resolveWireId maps live wire ids to slots; stale/despawned/never-used -> -1", () => {
  const sim = new SimWorld();
  const eid = sim.spawn();
  const wid = sim.wireId(eid);
  assert.equal(sim.resolveWireId(wid), eid);

  // Never-used slot (no generation entry): generation-0 guess must not hit.
  assert.equal(sim.resolveWireId(makeWireEntityId(0, 999)), -1);

  // Stale generation: forge a wire id for this slot with a wrong generation.
  const stale = makeWireEntityId(
    parseWireEntityId(wid).generation + 1,
    parseWireEntityId(wid).slot,
  );
  assert.equal(sim.resolveWireId(stale), -1);

  // Despawned slot: the old wire id no longer resolves.
  sim.despawn(eid);
  assert.equal(sim.resolveWireId(wid), -1);

  // Slot reuse bumps the generation: the new wire id resolves, the old one stays dead.
  const eid2 = sim.spawn();
  const wid2 = sim.wireId(eid2);
  assert.notEqual(wid2, wid);
  assert.equal(sim.resolveWireId(wid2), eid2);
  assert.equal(sim.resolveWireId(wid), -1);
});
