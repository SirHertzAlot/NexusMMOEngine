/**
 * BotSystem — computer-driven characters living in the world like players.
 *
 * A bot is the same entity a player's avatar is (Transform, Velocity,
 * PlayerIntent, Health, Locomotion, Appearance, Action), so it streams
 * chunks around itself, walks, swims and fights through the very systems
 * players do; only its intent comes from a small brain here instead of a
 * client. Each bot wears a random look from the part catalog.
 *
 * Behaviour (enough to bring a scene to life, not AI):
 *  - sparring pairs: partners close to arm's length, face each other, and
 *    trade roles every few seconds — the attacker presses the sword combo
 *    in rhythm, the defender holds its guard and now and then rolls aside;
 *  - wanderers: stroll between random points around home, pausing to idle.
 *
 * Runs before IntentSystem (which turns the intent into velocity).
 */

import { addComponent, entityExists } from "bitecs";
import { IntentButton, LocomotionMode } from "@mmo-engine/protocol";
import { HAIR_COLOURS, SKIN_TONES, lookToJson, randomLook, type CharacterLook, type Gender, type ModularCatalog } from "@mmo-engine/art/character";
import * as C from "./components.js";
import type { SimSystem } from "./systems.js";
import type { SimWorld } from "./world.js";
import { hash } from "./procgen/ecology.js";

export interface BotOptions {
  count: number;
  /** Where they gather. */
  home: { x: number; z: number };
  /** How far from home they roam, metres. */
  radius?: number;
  seed?: number;
  /** The part catalog for their looks (null: default parts, varied colours). */
  catalog: ModularCatalog | null;
  groundHeightAt?: (x: number, z: number) => number;
  /** Abilities (protocol Ability bits); default: swim. */
  abilities?: number;
}

type Brain =
  | { kind: "wander"; target: { x: number; z: number }; waitUntil: number }
  | { kind: "spar"; partner: number; attacker: boolean; swapAt: number; nextPress: number; step: number; rollAt: number };

const TICK_HZ = 30;
/** Arm's length for a sword fight, metres. */
const SPAR_RANGE = 1.9;

export class BotSystem implements SimSystem {
  readonly name = "bots";
  private readonly bots: number[] = [];
  private readonly brains = new Map<number, Brain>();
  private spawned = false;
  private rngState: number;

  constructor(private readonly opts: BotOptions) {
    this.rngState = opts.seed ?? 20260928;
  }

  /** Bot entity ids. */
  get entities(): readonly number[] {
    return this.bots;
  }

  private rand(): number {
    this.rngState = hash(this.rngState, 0x5bd1e995);
    return this.rngState / 4294967296;
  }

  private lookFor(i: number): string {
    const gender: Gender = i % 2 === 0 ? "male" : "female";
    const rng = (): number => this.rand();
    if (this.opts.catalog) return lookToJson(randomLook(this.opts.catalog, gender, rng));
    const hair = HAIR_COLOURS[Math.floor(rng() * HAIR_COLOURS.length)];
    const look: CharacterLook = { gender, parts: {}, colours: { skin: SKIN_TONES[Math.floor(rng() * SKIN_TONES.length)], hair } };
    return lookToJson(look);
  }

  private spawnAll(sim: SimWorld): void {
    this.spawned = true;
    const { home, count } = this.opts;
    const radius = this.opts.radius ?? 18;
    for (let i = 0; i < count; i++) {
      const eid = sim.spawn();
      for (const c of [C.Transform, C.Velocity, C.PlayerIntent, C.Health, C.Locomotion, C.Action]) addComponent(sim.ecs, c, eid);
      const a = this.rand() * Math.PI * 2;
      const r = 4 + this.rand() * (radius - 4);
      const x = home.x + Math.cos(a) * r;
      const z = home.z + Math.sin(a) * r;
      C.Transform.px[eid] = x;
      C.Transform.pz[eid] = z;
      C.Transform.py[eid] = this.opts.groundHeightAt?.(x, z) ?? 0;
      C.Transform.qw[eid] = 1;
      C.Transform.sx[eid] = 1;
      C.Transform.sy[eid] = 1;
      C.Transform.sz[eid] = 1;
      C.Health.current[eid] = 100;
      C.Health.max[eid] = 100;
      C.Locomotion.mode[eid] = LocomotionMode.Ground;
      C.Locomotion.abilities[eid] = this.opts.abilities ?? 1;
      C.Locomotion.breath[eid] = 1;
      C.Action.move[eid] = 0;
      sim.setLook(eid, this.lookFor(i));
      this.bots.push(eid);
    }
    // Two in three fight: pairs of neighbours in the list.
    const sparring = Math.floor((count * 2) / 3 / 2) * 2;
    for (let i = 0; i < count; i++) {
      const eid = this.bots[i];
      if (i < sparring) {
        const partner = this.bots[i ^ 1];
        this.brains.set(eid, { kind: "spar", partner, attacker: i % 2 === 0, swapAt: 0, nextPress: 0, step: 0, rollAt: 0 });
      } else {
        this.brains.set(eid, { kind: "wander", target: { x: C.Transform.px[eid], z: C.Transform.pz[eid] }, waitUntil: 0 });
      }
    }
  }

  step(sim: SimWorld, _dt: number): void {
    if (!this.spawned) this.spawnAll(sim);
    const tick = sim.currentTick;
    for (const e of this.bots) {
      if (!entityExists(sim.ecs, e)) continue;
      const brain = this.brains.get(e)!;
      const I = C.PlayerIntent;
      I.mx[e] = 0;
      I.my[e] = 0;
      I.mz[e] = 0;
      I.jump[e] = 0;
      I.buttons[e] = 0;
      if (brain.kind === "wander") this.wander(e, brain, tick);
      else this.spar(sim, e, brain, tick);
    }
  }

  private moveToward(e: number, x: number, z: number, speed: number): number {
    const dx = x - C.Transform.px[e];
    const dz = z - C.Transform.pz[e];
    const d = Math.hypot(dx, dz);
    if (d > 1e-3) {
      C.PlayerIntent.mx[e] = (dx / d) * speed;
      C.PlayerIntent.mz[e] = (dz / d) * speed;
      C.PlayerIntent.lookYaw[e] = Math.atan2(dx, dz);
    }
    return d;
  }

  private wander(e: number, b: Extract<Brain, { kind: "wander" }>, tick: number): void {
    if (tick < b.waitUntil) return;
    const d = this.moveToward(e, b.target.x, b.target.z, 0.35); // a stroll
    if (d < 0.8) {
      const radius = this.opts.radius ?? 18;
      const a = this.rand() * Math.PI * 2;
      const r = this.rand() * radius;
      b.target = { x: this.opts.home.x + Math.cos(a) * r, z: this.opts.home.z + Math.sin(a) * r };
      b.waitUntil = tick + Math.floor((1 + this.rand() * 3) * TICK_HZ);
    }
  }

  private spar(sim: SimWorld, e: number, b: Extract<Brain, { kind: "spar" }>, tick: number): void {
    if (!entityExists(sim.ecs, b.partner)) return;
    const px = C.Transform.px[b.partner];
    const pz = C.Transform.pz[b.partner];
    const dx = px - C.Transform.px[e];
    const dz = pz - C.Transform.pz[e];
    const d = Math.hypot(dx, dz);
    C.PlayerIntent.lookYaw[e] = Math.atan2(dx, dz);
    if (d > SPAR_RANGE + 0.6) {
      // Close in (the attacker walks up; the defender waits).
      if (b.attacker) this.moveToward(e, px, pz, 0.45);
      return;
    }
    // The attacker hands over every few seconds; both then share the next swap time.
    if (b.attacker && tick >= b.swapAt) {
      const p = this.brains.get(b.partner);
      const next = tick + Math.floor((5 + this.rand() * 3) * TICK_HZ);
      if (b.swapAt !== 0 && p?.kind === "spar") {
        b.attacker = false;
        p.attacker = true;
        p.nextPress = tick + TICK_HZ;
        p.step = 0;
        b.rollAt = tick + Math.floor((2 + this.rand() * 3) * TICK_HZ);
      } else {
        b.nextPress = tick + TICK_HZ;
        if (p?.kind === "spar") p.rollAt = tick + Math.floor((2 + this.rand() * 3) * TICK_HZ);
      }
      b.swapAt = next;
      if (p?.kind === "spar") p.swapAt = next;
    }
    if (b.attacker) {
      // The combo in rhythm: three presses, then a breath.
      if (tick >= b.nextPress) {
        C.PlayerIntent.buttons[e] = IntentButton.Attack;
        b.step = (b.step + 1) % 3;
        b.nextPress = tick + (b.step === 0 ? Math.floor(1.6 * TICK_HZ) : 8);
      }
      if (d < SPAR_RANGE - 0.5) this.moveToward(e, C.Transform.px[e] - dx, C.Transform.pz[e] - dz, 0.3); // step back
    } else if (tick >= b.rollAt && tick < b.rollAt + 2) {
      // Roll aside, square to the attacker.
      C.PlayerIntent.mx[e] = dz / (d || 1);
      C.PlayerIntent.mz[e] = -dx / (d || 1);
      C.PlayerIntent.buttons[e] = tick === b.rollAt ? IntentButton.Dodge : 0;
      if (tick === b.rollAt + 1) b.rollAt = tick + Math.floor((3 + this.rand() * 4) * TICK_HZ);
    } else {
      C.PlayerIntent.buttons[e] = IntentButton.Block;
    }
  }
}
