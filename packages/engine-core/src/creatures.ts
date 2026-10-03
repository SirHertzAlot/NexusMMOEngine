/**
 * CreatureSystem: rules-driven monsters (roadmap AI1).
 *
 * A creature is the bot's entity (Transform, Velocity, PlayerIntent, Health,
 * Locomotion, Action, NavAgent) with a small brain. It idles at home, wakes
 * when a living character comes within `aggroRadius`, chases and swings
 * through intent like a player's client would, and walks home (healing)
 * once its target dies or it strays beyond `leashRadius` from home. Packs
 * spawn together; every number comes from content/rules/creatures.json.
 * Death and respawn belong to DeathSystem: `respawnSeconds` gives the delay
 * and `place` puts the body back at home.
 *
 * Runs before CrowdSystem and IntentSystem.
 */

import { addComponent, defineQuery, entityExists } from "bitecs";
import { IntentButton, LocomotionMode } from "@mmo-engine/protocol";
import type { CreaturesRules, ItemBaseRules } from "@mmo-engine/rules";
import * as C from "./components.js";
import type { Weapon } from "./combat.js";
import { PLAYER_SPEED, type SimSystem } from "./systems.js";
import type { SimWorld } from "./world.js";
import { hash } from "./procgen/ecology.js";

export interface CreatureOptions {
  creatures: CreaturesRules["creatures"];
  /** Item bases by id (the creature's weapon physics). */
  bases: Record<string, ItemBaseRules>;
  groundHeightAt?: (x: number, z: number) => number;
  seed?: number;
  /** Look JSON a creature shows as, by creature id (none: the client's placeholder). */
  lookOf?: (creature: string) => string | undefined;
  /** Walk by NavAgent targets (a CrowdSystem runs after this). */
  steer?: boolean;
  tickHz?: number;
}

type Mode = "idle" | "chase" | "return";

interface Brain {
  kind: string;
  homeX: number;
  homeZ: number;
  weapon: Weapon;
  mode: Mode;
  target: number;
  nextSwing: number;
  /** Tick the walk target is next re-given to the crowd. */
  nextGive: number;
}

/** A creature swings this far inside its weapon's reach, metres. */
const REACH_MARGIN = 0.3;
/** Home counts as reached inside this, metres. */
const HOME_RADIUS = 1.5;
/** Re-aim a steered walk this often, ticks. */
const GIVE_EVERY = 10;

export class CreatureSystem implements SimSystem {
  readonly name = "creatures";
  private readonly brains = new Map<number, Brain>();
  private readonly characters = defineQuery([C.Transform, C.Health, C.CharacterRef]);
  private rngState: number;
  private readonly tickHz: number;

  private readonly opts: CreatureOptions;

  constructor(opts: CreatureOptions) {
    this.opts = { ...opts };
    this.rngState = opts.seed ?? 20261002;
    this.tickHz = opts.tickHz ?? 30;
  }

  /**
   * Swap in reloaded tables (ED1). Living creatures take the new aggro,
   * leash, speed, attack rate and respawn delay at once; health and the
   * weapon held are set at spawn. A creature whose kind was removed stands
   * idle until it dies.
   */
  setRules(creatures: CreaturesRules["creatures"], bases: Record<string, ItemBaseRules>): void {
    this.opts.creatures = creatures;
    this.opts.bases = bases;
    for (const [e, b] of this.brains) {
      const def = creatures[b.kind];
      if (def) C.NavAgent.speed[e] = def.chaseSpeed * PLAYER_SPEED;
    }
  }

  get size(): number {
    return this.brains.size;
  }

  isCreature(e: number): boolean {
    return this.brains.has(e);
  }

  private rand(): number {
    this.rngState = hash(this.rngState, 0x5bd1e995);
    return this.rngState / 4294967296;
  }

  /** A creature's display name (its rules' `name`), or undefined if `e` is not one. */
  nameOf(e: number): string | undefined {
    const b = this.brains.get(e);
    return b ? this.opts.creatures[b.kind]?.name : undefined;
  }

  /** Every live creature entity. */
  entities(): IterableIterator<number> {
    return this.brains.keys();
  }

  /** What a creature swings, or null if `e` is not one. */
  weaponOf(e: number): Weapon | null {
    return this.brains.get(e)?.weapon ?? null;
  }

  /** The kind id of creature `e`, or undefined if `e` is not one. */
  kindOf(e: number): string | undefined {
    return this.brains.get(e)?.kind;
  }

  /** Seconds before a dead creature rises, or undefined if `e` is not one. */
  respawnSeconds(e: number): number | undefined {
    const b = this.brains.get(e);
    return b ? this.opts.creatures[b.kind]?.respawnSeconds : undefined;
  }

  /** Put a respawning creature back at home with a fresh brain. False if `e` is not one. */
  place(_sim: SimWorld, e: number): boolean {
    const b = this.brains.get(e);
    if (!b) return false;
    C.Transform.px[e] = b.homeX;
    C.Transform.pz[e] = b.homeZ;
    C.Transform.py[e] = this.opts.groundHeightAt?.(b.homeX, b.homeZ) ?? C.Transform.py[e];
    C.Velocity.lx[e] = 0;
    C.Velocity.lz[e] = 0;
    b.mode = "idle";
    b.target = -1;
    this.stop(e);
    return true;
  }

  /**
   * Spawn one pack of `kind` around (x, z): a random size in the creature's
   * pack range, each a few metres from the centre. Returns the entity ids.
   */
  spawnPack(sim: SimWorld, kind: string, x: number, z: number): number[] {
    const def = this.opts.creatures[kind];
    if (!def) throw new Error(`unknown creature "${kind}"`);
    const [min, max] = def.pack;
    const n = min + Math.floor(this.rand() * (max - min + 1));
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.rand() * 0.8;
      const r = n === 1 ? 0 : 1.5 + this.rand() * 1.5;
      out.push(this.spawn(sim, kind, x + Math.cos(a) * r, z + Math.sin(a) * r));
    }
    return out;
  }

  spawn(sim: SimWorld, kind: string, x: number, z: number): number {
    const def = this.opts.creatures[kind];
    if (!def) throw new Error(`unknown creature "${kind}"`);
    const baseId = def.weapons[Math.floor(this.rand() * def.weapons.length)];
    const base = this.opts.bases[baseId];
    if (!base) throw new Error(`creature "${kind}" weapon "${baseId}" is not an item base`);
    const eid = sim.spawn();
    for (const c of [C.Transform, C.Velocity, C.PlayerIntent, C.Health, C.Locomotion, C.Action, C.NavAgent]) {
      addComponent(sim.ecs, c, eid);
    }
    C.Transform.px[eid] = x;
    C.Transform.pz[eid] = z;
    C.Transform.py[eid] = this.opts.groundHeightAt?.(x, z) ?? 0;
    C.Transform.qw[eid] = 1;
    C.Transform.sx[eid] = C.Transform.sy[eid] = C.Transform.sz[eid] = 1;
    C.Health.current[eid] = C.Health.max[eid] = def.health;
    C.Locomotion.mode[eid] = LocomotionMode.Ground;
    C.Locomotion.abilities[eid] = 1;
    C.Locomotion.breath[eid] = 1;
    C.Action.move[eid] = 0;
    C.NavAgent.speed[eid] = def.chaseSpeed * PLAYER_SPEED;
    C.NavAgent.tx[eid] = NaN;
    C.NavAgent.seq[eid] = 0;
    const look = this.opts.lookOf?.(kind);
    if (look) sim.setLook(eid, look);
    this.brains.set(eid, {
      kind,
      homeX: x,
      homeZ: z,
      weapon: {
        technique: base.technique,
        item: { mass: base.mass, edge: base.edge, point: base.point, hardness: base.hardness },
        reach: base.length,
      },
      mode: "idle",
      target: -1,
      nextSwing: 0,
      nextGive: 0,
    });
    return eid;
  }

  step(sim: SimWorld): void {
    if (this.brains.size === 0) return;
    const tick = sim.currentTick;
    const players = this.characters(sim.ecs);
    for (const [e, b] of this.brains) {
      if (!entityExists(sim.ecs, e)) {
        this.brains.delete(e);
        continue;
      }
      C.PlayerIntent.mx[e] = 0;
      C.PlayerIntent.my[e] = 0;
      C.PlayerIntent.mz[e] = 0;
      C.PlayerIntent.jump[e] = 0;
      C.PlayerIntent.buttons[e] = 0;
      if (C.Health.current[e] <= 0) {
        b.mode = "idle"; // dead: DeathSystem holds the body, `place` resets it
        b.target = -1;
        continue;
      }
      const def = this.opts.creatures[b.kind];
      if (!def) {
        b.mode = "idle"; // kind removed by a rules reload
        b.target = -1;
        this.stop(e);
        continue;
      }
      const ex = C.Transform.px[e];
      const ez = C.Transform.pz[e];
      if (b.mode !== "return" && (b.target < 0 || !this.alive(sim, b.target))) {
        b.target = this.nearestLiving(players, ex, ez, def.aggroRadius);
        if (b.target >= 0) b.mode = "chase";
        else b.mode = Math.hypot(ex - b.homeX, ez - b.homeZ) > HOME_RADIUS ? "return" : "idle";
      }
      if (b.mode === "chase") {
        if (Math.hypot(ex - b.homeX, ez - b.homeZ) > def.leashRadius) {
          b.mode = "return";
          b.target = -1;
        } else {
          this.chase(e, b, tick, def.attackEverySeconds);
        }
      }
      if (b.mode === "return") {
        const d = this.walk(e, b, tick, b.homeX, b.homeZ);
        if (d < HOME_RADIUS) {
          b.mode = "idle";
          C.Health.current[e] = C.Health.max[e];
          this.stop(e);
        }
      }
    }
  }

  private alive(sim: SimWorld, t: number): boolean {
    return entityExists(sim.ecs, t) && C.Health.current[t] > 0;
  }

  private nearestLiving(ids: ArrayLike<number>, x: number, z: number, radius: number): number {
    let best = -1;
    let bestD = radius;
    for (let i = 0; i < ids.length; i++) {
      const p = ids[i];
      if (C.Health.current[p] <= 0) continue;
      const d = Math.hypot(C.Transform.px[p] - x, C.Transform.pz[p] - z);
      if (d <= bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private chase(e: number, b: Brain, tick: number, everySeconds: number): void {
    const tx = C.Transform.px[b.target];
    const tz = C.Transform.pz[b.target];
    const dx = tx - C.Transform.px[e];
    const dz = tz - C.Transform.pz[e];
    const d = Math.hypot(dx, dz);
    C.PlayerIntent.lookYaw[e] = Math.atan2(dx, dz);
    if (d > b.weapon.reach + REACH_MARGIN) {
      this.walk(e, b, tick, tx, tz);
      return;
    }
    this.stop(e);
    if (tick >= b.nextSwing) {
      C.PlayerIntent.buttons[e] = IntentButton.Attack;
      b.nextSwing = tick + Math.round(everySeconds * this.tickHz);
    }
  }

  /** Walk toward a point (crowd-steered when running); returns the distance left. */
  private walk(e: number, b: Brain, tick: number, x: number, z: number): number {
    const dx = x - C.Transform.px[e];
    const dz = z - C.Transform.pz[e];
    const d = Math.hypot(dx, dz);
    if (this.opts.steer === true && C.NavAgent.state[e] !== C.NavAgentState.Invalid) {
      if (tick >= b.nextGive) {
        this.give(e, x, z);
        b.nextGive = tick + GIVE_EVERY;
      }
    } else if (d > 1e-3) {
      const speed = this.opts.creatures[b.kind]?.chaseSpeed ?? 0;
      C.PlayerIntent.mx[e] = (dx / d) * speed;
      C.PlayerIntent.mz[e] = (dz / d) * speed;
      C.PlayerIntent.lookYaw[e] = Math.atan2(dx, dz);
    }
    return d;
  }

  private stop(e: number): void {
    if (this.opts.steer === true) this.give(e, NaN, NaN);
  }

  private give(e: number, x: number, z: number): void {
    C.NavAgent.tx[e] = x;
    C.NavAgent.ty[e] = Number.isNaN(x) ? 0 : (this.opts.groundHeightAt?.(x, z) ?? C.Transform.py[e]);
    C.NavAgent.tz[e] = z;
    C.NavAgent.seq[e] = (C.NavAgent.seq[e] + 1) & 0xffff;
  }
}
