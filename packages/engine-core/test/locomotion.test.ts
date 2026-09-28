/**
 * Locomotion: walking into the sea and swimming, diving and breath,
 * drowning, and flight for entities that have it — CharacterSystem with
 * the IntentSystem → IntegrateSystem → CharacterSystem order the server
 * runs, over a beach that shelves into the sea.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { Ability, IntentButton, LocomotionMode } from "@mmo-engine/protocol";
import {
  BREATH_SECONDS,
  CharacterSystem,
  collectDeltaState,
  collectFullState,
  decodeSnapshot,
  DeltaTracker,
  encodeSnapshot,
  FLOAT_DEPTH,
  FLY_SPEED,
  FLY_VERTICAL_SPEED,
  Health,
  IntegrateSystem,
  IntentSystem,
  Locomotion,
  MAX_FLIGHT_HEIGHT,
  PLAYER_SPEED,
  PlayerIntent,
  SimWorld,
  SWIM_SPEED,
  Transform,
  Velocity,
  type ChunkDataSource,
} from "../src/index.js";

const DT = 1 / 30;

/** Dry land (1 m) west of x = 0, then a beach shelving 1 m per 4 m into the sea. */
const groundAt = (x: number): number => (x < 0 ? 1 : 1 - x * 0.25);
const beach: ChunkDataSource = {
  chunkSamples: 256,
  generateChunk: (_seed, cx, _cz, _lod, out) => {
    for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) out[j * 16 + i] = groundAt(cx * 16 + (i * 16) / 15);
  },
};
/** The sea (surface 0) reaches up the beach to x = -8. */
const sea = (x: number): number | null => (x > -8 ? 0 : null);

function world(x: number, abilities: number): { sim: SimWorld; e: number; tick: (n: number) => void } {
  const sim = new SimWorld();
  const e = sim.spawn();
  for (const c of [Transform, Velocity, PlayerIntent, Health, Locomotion]) addComponent(sim.ecs, c, e);
  Transform.px[e] = x;
  Transform.py[e] = groundAt(x);
  Transform.pz[e] = 4;
  Health.current[e] = 100;
  Health.max[e] = 100;
  Locomotion.mode[e] = LocomotionMode.Ground;
  Locomotion.abilities[e] = abilities;
  Locomotion.breath[e] = 1;
  const systems = [new IntentSystem(), new IntegrateSystem(), new CharacterSystem({ chunkSource: beach, worldSeed: 1n, water: sea })];
  const tick = (n: number): void => {
    for (let k = 0; k < n; k++) for (const s of systems) s.step(sim, DT);
  };
  return { sim, e, tick };
}

/** Read through a function: TS narrows `Locomotion.mode[e]` after an assert. */
const modeOf = (e: number): number => Locomotion.mode[e];

const intent = (e: number, mx: number, my = 0, buttons = 0): void => {
  PlayerIntent.mx[e] = mx;
  PlayerIntent.my[e] = my;
  PlayerIntent.buttons[e] = buttons;
};

test("walking into deep water starts swimming; afloat, the head stays above the surface", () => {
  const { e, tick } = world(2, Ability.Swim);
  intent(e, 1);
  tick(30); // 6 m: still wading
  assert.equal(Locomotion.mode[e], LocomotionMode.Ground);
  assert.equal(Velocity.lx[e], PLAYER_SPEED);
  while (modeOf(e) !== LocomotionMode.Swim && Transform.px[e] < 30) tick(1);
  assert.equal(Locomotion.mode[e], LocomotionMode.Swim, "deep enough to swim");
  assert.ok(Transform.px[e] > 8 && Transform.px[e] < 11, `started swimming at x=${Transform.px[e].toFixed(1)} (1.3 m deep)`);
  tick(30); // on into deeper water
  assert.equal(Velocity.lx[e], SWIM_SPEED, "swimming is slower than walking");
  intent(e, 0);
  tick(90); // bob up to the float line
  assert.ok(Math.abs(Transform.py[e] - -FLOAT_DEPTH) < 0.05, `floating at ${Transform.py[e].toFixed(2)}`);
  assert.equal(Locomotion.breath[e], 1, "head above water: breathing");
});

test("back in the shallows the swimmer stands up and walks", () => {
  const { e, tick } = world(20, Ability.Swim);
  Locomotion.mode[e] = LocomotionMode.Swim;
  Transform.py[e] = -FLOAT_DEPTH;
  intent(e, -1);
  while (modeOf(e) === LocomotionMode.Swim && Transform.px[e] > -5) tick(1);
  assert.equal(Locomotion.mode[e], LocomotionMode.Ground);
  tick(30);
  assert.ok(Math.abs(Transform.py[e] - groundAt(Transform.px[e])) < 1e-4, "feet on the beach");
});

test("diving: down to the bottom, breath held under water, back when surfacing", () => {
  const { e, tick } = world(30, Ability.Swim); // 6.5 m deep
  Locomotion.mode[e] = LocomotionMode.Swim;
  Transform.py[e] = -FLOAT_DEPTH;
  intent(e, 0, -1);
  tick(150); // 5 s diving
  const bottom = groundAt(Transform.px[e]);
  assert.ok(Math.abs(Transform.py[e] - (bottom + 0.05)) < 0.1, `on the bottom (${Transform.py[e].toFixed(2)} vs ${bottom.toFixed(2)})`);
  const held = Locomotion.breath[e];
  assert.ok(held < 1 && held > 1 - 5 / BREATH_SECONDS - 0.01, `breath ${held.toFixed(3)} after ~5 s under`);
  intent(e, 0, 1);
  tick(150); // swim up and breathe
  assert.ok(Math.abs(Transform.py[e] - -FLOAT_DEPTH) < 0.05, "back at the surface");
  assert.ok(Locomotion.breath[e] > held, "breathing again");
});

test("out of air: the swimmer is pushed up and loses health until surfacing", () => {
  const { e, tick } = world(30, Ability.Swim);
  Locomotion.mode[e] = LocomotionMode.Swim;
  Transform.py[e] = groundAt(30) + 0.05;
  Locomotion.breath[e] = 0.001;
  intent(e, 0, -1); // still trying to stay down
  tick(30);
  assert.ok(Health.current[e] < 100, `drowning: health ${Health.current[e].toFixed(1)}`);
  assert.ok(Velocity.ly[e] > 0, "forced up");
  intent(e, 0); // stop fighting it
  tick(150);
  assert.ok(Math.abs(Transform.py[e] - -FLOAT_DEPTH) < 0.05, "surfaced");
  const hurt = Health.current[e];
  tick(30);
  assert.equal(Health.current[e], hurt, "no more damage once breathing");
});

test("without the swim ability you walk along the bottom", () => {
  const { e, tick } = world(20, 0);
  tick(30);
  assert.equal(Locomotion.mode[e], LocomotionMode.Ground);
  assert.ok(Math.abs(Transform.py[e] - groundAt(20)) < 1e-4);
});

test("flight: only with the ability; take off, climb, cruise, ceiling, land", () => {
  const walker = world(-20, Ability.Swim);
  intent(walker.e, 0, 0, IntentButton.ToggleFlight);
  walker.tick(5);
  assert.equal(Locomotion.mode[walker.e], LocomotionMode.Ground, "no wings, no flight");

  const { e, tick } = world(-20, Ability.Swim | Ability.Fly);
  intent(e, 0, 0, IntentButton.ToggleFlight);
  tick(1);
  assert.equal(Locomotion.mode[e], LocomotionMode.Fly, "took off");
  intent(e, 0, 1); // release the button, climb
  tick(30);
  assert.ok(Math.abs(Transform.py[e] - (1 + FLY_VERTICAL_SPEED * (29 / 30))) < 0.3, `climbed to ${Transform.py[e].toFixed(2)}`);
  intent(e, -1, 0);
  tick(1); // the last climb step lands this tick
  const cruising = Transform.py[e];
  tick(30);
  assert.equal(Transform.py[e], cruising, "no gravity in flight");
  assert.equal(Velocity.lx[e], -FLY_SPEED, "fast");
  intent(e, 0, 1);
  tick(30 * 60);
  assert.ok(Transform.py[e] <= groundAt(Transform.px[e]) + MAX_FLIGHT_HEIGHT + 1e-3, "held under the ceiling");
  intent(e, 0, -1);
  for (let k = 0; k < 30 * 120 && modeOf(e) === LocomotionMode.Fly; k++) tick(1);
  assert.equal(Locomotion.mode[e], LocomotionMode.Ground, "landed");
});

test("flight: toggling off mid-air falls; diving into deep water swims", () => {
  const { e, tick } = world(-20, Ability.Swim | Ability.Fly);
  intent(e, 0, 0, IntentButton.ToggleFlight);
  tick(1);
  intent(e, 0, 1);
  tick(60);
  intent(e, 0, 0, IntentButton.ToggleFlight);
  tick(1);
  assert.equal(Locomotion.mode[e], LocomotionMode.Ground);
  intent(e, 0, 0);
  tick(5);
  assert.ok(Velocity.ly[e] < 0, "falling");

  const diver = world(30, Ability.Swim | Ability.Fly);
  intent(diver.e, 0, 0, IntentButton.ToggleFlight);
  diver.tick(1); // take off from the sea floor, over deep water
  intent(diver.e, 0, 0);
  diver.tick(60);
  const hover = Transform.py[diver.e];
  assert.ok(hover >= 0 && hover < 0.5, `climbed out of the water, then hovers (${hover.toFixed(2)})`);
  intent(diver.e, 0, 1);
  diver.tick(30);
  intent(diver.e, 0, -1);
  for (let k = 0; k < 30 * 60 && modeOf(diver.e) === LocomotionMode.Fly; k++) diver.tick(1);
  assert.equal(Locomotion.mode[diver.e], LocomotionMode.Swim, "dived in");
});

test("locomotion travels in snapshots and deltas and survives a restore", () => {
  const { sim, e, tick } = world(20, Ability.Swim | Ability.Fly);
  const tracker = new DeltaTracker();
  tracker.commit(sim);
  tick(5); // walks into the water: swimming now
  const delta = collectDeltaState(sim, 1, 0, tracker);
  const row = delta.locomotions.find((r) => r.wireId === sim.wireId(e));
  assert.ok(row, "the mode change is in the delta");
  assert.equal(row.mode, LocomotionMode.Swim);

  const saved = decodeSnapshot(encodeSnapshot(collectFullState(sim, 1)));
  assert.deepEqual(
    saved.locomotions.map((r) => [r.mode, r.abilities]),
    [[LocomotionMode.Swim, Ability.Swim | Ability.Fly]],
  );
  SimWorld.resetEntityCursorForTesting();
  const restored = new SimWorld();
  restored.restoreFromState(saved, new Map());
  const slot = Number(saved.locomotions[0].wireId & 0xffffffffn);
  assert.equal(Locomotion.mode[slot], LocomotionMode.Swim);
  assert.equal(Locomotion.abilities[slot], Ability.Swim | Ability.Fly);
});
