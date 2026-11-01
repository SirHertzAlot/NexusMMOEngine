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
 *
 * Wildlife (docs/WILDLIFE.md) adds a `behavior` to a kind's rules, and the
 * same brain runs every kind from data, with no species-specific code:
 *  - temperament: `hunt` (the goblin's), `flee` (prey runs from whoever comes
 *    within `noticeM`), `defend` (fights only when hurt), `territorial`
 *    (warns, then drives the intruder off and gives up when it leaves),
 *    `raid` (instinct: when hungry, goes for the best settlement within its
 *    range, takes the pull of players, livestock and structures by weight,
 *    is sated after a while of fighting and goes home to its lair);
 *  - `telegraphS`: a visible warning (telegraph 0x1e) before it strikes;
 *  - `tactics`: flank (pack members come in from alternating sides), ambush
 *    (notices only what comes close);
 *  - `activity`: asleep outside its hours, a light sleeper (notices less);
 *  - `habitat: water`: confined to water cells, swims, keeps its depth.
 * Pack-mates alert each other. No allocation in the tick: the brain is
 * numbers, the scans are loops.
 */

import { addComponent, defineQuery, entityExists, hasComponent } from "bitecs";
import { IntentButton, LocomotionMode } from "@mmo-engine/protocol";
import { type CreaturesRules, type ItemBaseRules, CreatureAiSchema, type CreatureAiRules } from "@mmo-engine/rules";
import { fnv1a32 } from "@mmo-engine/scatter";
import * as C from "./components.js";
import type { Weapon } from "./combat.js";
import { CHARACTER_CAPSULE, PLAYER_SPEED, type SimSystem } from "./systems.js";
import { clearOfStatics } from "./prop-collision.js";
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
  /** The rules' damage mass power (combat.json damage.massPower): damageX scales the weapon's mass by it. Default 0.5. */
  massPower?: number;
  /** Time of day 0..1 (0 = midnight) at a tick; null or absent: no day cycle, everyone is awake. */
  timeOfDay?: (tick: number) => number | null;
  /** Show a warning cone at (x, z) facing yaw for `ms` (the TelegraphSystem, damage 0). */
  warn?: (e: number, x: number, z: number, yaw: number, range: number, ms: number, tick: number) => void;
  /** Cancel the warnings creature `e` has up. */
  cancelWarn?: (e: number, tick: number) => void;
  /** Who last hurt `e` (CombatSystem.lastAttacker), or -1/undefined. */
  attackerOf?: (e: number) => number | undefined;
  /** Metres of water over the ground at (x, z), 0 on dry land. Aquatic creatures stay where it is deep enough. */
  waterDepthAt?: (x: number, z: number) => number;
  /** The water surface height at (x, z), null if none. */
  waterSurfaceAt?: (x: number, z: number) => number | null;
  /** Settlements a raider may go for. */
  settlements?: () => readonly RaidSettlement[];
  /** The art model id a kind shows as (its AssetRef hash), scaled by its `size`. */
  modelOf?: (creature: string) => string | undefined;
  /** Brain pacing and ranges (creatures.json `ai`); default: the engine's. */
  ai?: CreatureAiRules;
}

/** A place raiders are drawn to. */
export interface RaidSettlement { x: number; z: number; /** Structures in it. */ size: number; /** Metres across from the centre. */ radius: number }

type Mode = "idle" | "chase" | "return" | "flee" | "warn" | "raid";

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
  /** Health last tick: a fall is a blow taken. */
  lastHealth: number;
  /** Tick the warning ends; no new warning until `calmUntil`. */
  warnUntil: number;
  calmUntil: number;
  /** Which side a flanker comes in from (+1 or -1). */
  side: number;
  /** Pack: mates share an id and alert each other. */
  group: number;
  /** Raid: the tick it is hungry, the settlement it goes for (-1: none), ticks spent fighting there. */
  hungryAt: number;
  raidIdx: number;
  raidFightTicks: number;
  nextScan: number;
  /** WL2 wandering: the stroll's point (NaN: not walking), and the tick the next stroll may start. */
  wanderX: number;
  wanderZ: number;
  wanderUntil: number;
}

/** A wandering creature's pace, as a share of its run speed. */
const WANDER_PACE = 0.35;

/** Brain pacing and ranges (creatures.json `ai`), until the system is given the game's. */
const DEFAULT_AI: Readonly<CreatureAiRules> = Object.freeze(CreatureAiSchema.parse({}));

type Def = CreaturesRules["creatures"][string];
type Behavior = NonNullable<Def["behavior"]>;

/** Whether a creature of `activity` is awake at time of day `t` (0..1, 0 = midnight). null: no day cycle. */
export function isAwake(activity: string, t: number | null): boolean {
  if (t === null) return true;
  switch (activity) {
    case "diurnal": return t >= 0.25 && t < 0.75;
    case "nocturnal": return t < 0.25 || t >= 0.75;
    case "crepuscular": return (t >= 0.2 && t < 0.35) || (t >= 0.65 && t < 0.8);
    default: return true;
  }
}

export class CreatureSystem implements SimSystem {
  readonly name = "creatures";
  private readonly brains = new Map<number, Brain>();
  private readonly characters = defineQuery([C.Transform, C.Health, C.CharacterRef]);
  private readonly everything = defineQuery([C.Transform, C.Health]);
  private rngState: number;
  private readonly tickHz: number;
  private nextGroup = 1;
  /** The world's walking speed creature speeds are shares of (rules movement.json); followed each step. */
  private walkSpeed = PLAYER_SPEED;
  private ai: Readonly<CreatureAiRules> = DEFAULT_AI;
  /** The ai's re-aim and raid rescan intervals, in ticks. */
  private repathTicks = 10;
  private rescanTicks = 15;

  private readonly opts: CreatureOptions;

  constructor(opts: CreatureOptions) {
    this.opts = { ...opts };
    this.rngState = opts.seed ?? 20261002;
    this.tickHz = opts.tickHz ?? 30;
    this.setAi(opts.ai ?? DEFAULT_AI);
  }

  /** Swap in reloaded brain pacing and ranges (creatures.json `ai`); applies on the next step. */
  setAi(ai: Readonly<CreatureAiRules>): void {
    this.ai = ai;
    this.repathTicks = Math.max(1, Math.round(ai.repathSeconds * this.tickHz));
    this.rescanTicks = Math.max(1, Math.round(ai.raidRescanSeconds * this.tickHz));
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
      if (def) C.NavAgent.speed[e] = this.runSpeed(def) * this.walkSpeed;
    }
  }

  /** Swap the settlements raiders may go for (a scene loaded after boot). */
  setSettlements(fn: (() => readonly RaidSettlement[]) | undefined): void {
    this.opts.settlements = fn;
  }

  get size(): number {
    return this.brains.size;
  }

  isCreature(e: number): boolean {
    return this.brains.has(e);
  }

  /** Whether `kind` has creature rules (and so can spawn). */
  has(kind: string): boolean {
    return kind in this.opts.creatures;
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

  /** What creature `e` is doing now (idle, chase, return, flee, warn, raid), or undefined if `e` is not one. */
  modeOf(e: number): string | undefined {
    return this.brains.get(e)?.mode;
  }

  /** The settlements being raided now (a creature in raid mode is on its way or fighting there), for the townspeople to take cover. */
  raids(): RaidSettlement[] {
    const list = this.opts.settlements?.();
    if (!list) return [];
    const out = new Set<RaidSettlement>();
    for (const b of this.brains.values()) {
      if (b.mode === "raid" && b.raidIdx >= 0 && list[b.raidIdx]) out.add(list[b.raidIdx]!);
    }
    return [...out];
  }

  /** Seconds before a dead creature rises, or undefined if `e` is not one. */
  respawnSeconds(e: number): number | undefined {
    const b = this.brains.get(e);
    return b ? this.opts.creatures[b.kind]?.respawnSeconds : undefined;
  }

  /** Put a respawning creature back at home with a fresh brain. False if `e` is not one. */
  place(sim: SimWorld, e: number): boolean {
    const b = this.brains.get(e);
    if (!b) return false;
    const def = this.opts.creatures[b.kind];
    C.Transform.px[e] = b.homeX;
    C.Transform.pz[e] = b.homeZ;
    C.Transform.py[e] = this.spawnY(def, b.homeX, b.homeZ, C.Transform.py[e]);
    C.Velocity.lx[e] = 0;
    C.Velocity.lz[e] = 0;
    b.mode = "idle";
    b.target = -1;
    b.lastHealth = C.Health.max[e];
    b.raidIdx = -1;
    b.wanderX = NaN;
    b.wanderZ = NaN;
    b.wanderUntil = 0;
    b.hungryAt = sim.currentTick + this.hungerTicks(def);
    this.stop(e);
    return true;
  }

  /**
   * Spawn one pack of `kind` around (x, z): a random size in the creature's
   * pack range (or `size`, a biome's own), each a few metres from the
   * centre. Returns the entity ids.
   */
  spawnPack(sim: SimWorld, kind: string, x: number, z: number, size?: readonly [number, number]): number[] {
    const def = this.opts.creatures[kind];
    if (!def) throw new Error(`unknown creature "${kind}"`);
    const [min, max] = size ?? def.pack;
    const n = min + Math.floor(this.rand() * (max - min + 1));
    const out: number[] = [];
    const group = this.nextGroup++;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.rand() * 0.8;
      const r = n === 1 ? 0 : 1.5 + this.rand() * 1.5;
      out.push(this.spawn(sim, kind, x + Math.cos(a) * r, z + Math.sin(a) * r, i, group));
    }
    return out;
  }

  spawn(sim: SimWorld, kind: string, x: number, z: number, index = 0, group = 0): number {
    const def = this.opts.creatures[kind];
    if (!def) throw new Error(`unknown creature "${kind}"`);
    const beh = def.behavior;
    const baseId = def.weapons[Math.floor(this.rand() * def.weapons.length)];
    const base = this.opts.bases[baseId];
    if (!base) throw new Error(`creature "${kind}" weapon "${baseId}" is not an item base`);
    const aquatic = beh?.habitat === "water";
    // Never inside a baked building; the cleared spot is also home. (Water is no place for a building.)
    if (!aquatic) ({ x, z } = clearOfStatics(sim, x, z, CHARACTER_CAPSULE.radius));
    const eid = sim.spawn();
    for (const c of [C.Transform, C.Velocity, C.PlayerIntent, C.Health, C.Locomotion, C.Action, C.NavAgent]) {
      addComponent(sim.ecs, c, eid);
    }
    const size = beh?.size ?? 1;
    C.Transform.px[eid] = x;
    C.Transform.pz[eid] = z;
    C.Transform.py[eid] = this.spawnY(def, x, z, 0);
    C.Transform.qw[eid] = 1;
    C.Transform.sx[eid] = C.Transform.sy[eid] = C.Transform.sz[eid] = size;
    C.Health.current[eid] = C.Health.max[eid] = def.health;
    C.Locomotion.mode[eid] = aquatic ? LocomotionMode.Swim : LocomotionMode.Ground;
    C.Locomotion.abilities[eid] = 1;
    C.Locomotion.breath[eid] = 1;
    C.Action.move[eid] = 0;
    this.walkSpeed = sim.movement.walkSpeed;
    C.NavAgent.speed[eid] = this.runSpeed(def) * this.walkSpeed;
    C.NavAgent.tx[eid] = NaN;
    C.NavAgent.seq[eid] = 0;
    const look = this.opts.lookOf?.(kind);
    if (look) sim.setLook(eid, look);
    const model = this.opts.modelOf?.(kind);
    if (model) {
      addComponent(sim.ecs, C.AssetRef, eid);
      C.AssetRef.assetHash[eid] = fnv1a32(model);
      C.AssetRef.variant[eid] = 0;
    }
    // damageX scales the blow: damage goes as mass^massPower, so mass goes as damageX^(1/massPower).
    const mass = base.mass * Math.pow(def.damageX ?? 1, 1 / (this.opts.massPower ?? 0.5));
    this.brains.set(eid, {
      kind,
      homeX: x,
      homeZ: z,
      weapon: {
        technique: base.technique,
        item: { mass, edge: base.edge, point: base.point, hardness: base.hardness },
        reach: base.length * size,
      },
      mode: "idle",
      target: -1,
      nextSwing: 0,
      nextGive: 0,
      lastHealth: def.health,
      warnUntil: 0,
      calmUntil: 0,
      side: index % 2 === 0 ? 1 : -1,
      group,
      hungryAt: sim.currentTick + Math.floor(this.rand() * 0.5 * this.hungerTicks(def)),
      raidIdx: -1,
      raidFightTicks: 0,
      nextScan: 0,
      wanderX: NaN,
      wanderZ: NaN,
      wanderUntil: 0,
    });
    return eid;
  }

  private runSpeed(def: Def): number {
    const base = def.behavior?.speedX ?? def.chaseSpeed;
    return def.behavior?.temperament === "flee" ? base * def.behavior.fleeSpeed : base;
  }

  private hungerTicks(def: Def | undefined): number {
    return Math.round((def?.behavior?.raid?.hungerSeconds ?? 600) * this.tickHz);
  }

  /** Where a creature stands: on the ground, or mid-depth in the water for the aquatic. */
  private spawnY(def: Def | undefined, x: number, z: number, fallback: number): number {
    const ground = this.opts.groundHeightAt?.(x, z) ?? fallback;
    if (!def || def.behavior?.habitat !== "water") return ground;
    const surface = this.opts.waterSurfaceAt?.(x, z);
    return surface == null ? ground : Math.max(ground + 0.1, surface - this.depthMid(def));
  }

  private depthMid(def: Def): number {
    const d = def.behavior?.depthM;
    return d ? (d[0] + d[1]) / 2 : 1;
  }

  step(sim: SimWorld): void {
    if (this.brains.size === 0) return;
    if (sim.movement.walkSpeed !== this.walkSpeed) {
      // A rules reload changed the walk: every creature's speed is a share of it.
      this.walkSpeed = sim.movement.walkSpeed;
      this.setRules(this.opts.creatures, this.opts.bases);
    }
    const tick = sim.currentTick;
    const players = this.characters(sim.ecs);
    const tod = this.opts.timeOfDay?.(tick) ?? null;
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
        if (b.mode === "warn") this.opts.cancelWarn?.(e, tick);
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
      const beh = def.behavior;
      const hp = C.Health.current[e];
      const hurt = hp < b.lastHealth - 1e-3;
      b.lastHealth = hp;
      // What it notices: its radius, less while asleep (outside its hours) or lying in wait.
      let notice = beh?.noticeM ?? def.aggroRadius;
      if (beh) {
        if (!isAwake(beh.activity, tod)) notice *= this.ai.asleepNotice;
        if (beh.tactics === "ambush") notice *= this.ai.ambushNotice;
      }
      this.think(sim, e, b, def, beh, notice, hurt, players, tick);
      if (b.mode === "idle" && beh && beh.wanderM > 0 && !hurt && isAwake(beh.activity, tod)) this.wander(e, b, beh, tick);
      if (beh?.habitat === "water") this.swim(e, def);
    }
  }

  private think(sim: SimWorld, e: number, b: Brain, def: Def, beh: Behavior | undefined, notice: number, hurt: boolean, players: ArrayLike<number>, tick: number): void {
    const temper = beh?.temperament ?? "hunt";
    const ex = C.Transform.px[e];
    const ez = C.Transform.pz[e];

    if (b.mode === "flee") {
      const t = this.nearestLiving(players, ex, ez, notice * this.ai.fleeCalmFactor);
      if (t < 0) {
        b.mode = "return";
        b.target = -1;
      } else {
        this.flee(e, b, tick, t);
        return;
      }
    }

    if (b.mode === "warn") {
      const t = b.target;
      const away = !this.alive(sim, t) || Math.hypot(C.Transform.px[t] - ex, C.Transform.pz[t] - ez) > notice * 1.3;
      if (away) {
        this.opts.cancelWarn?.(e, tick);
        b.mode = "idle";
        b.target = -1;
        b.calmUntil = tick + Math.round(this.ai.calmSeconds * this.tickHz);
      } else {
        C.PlayerIntent.lookYaw[e] = Math.atan2(C.Transform.px[t] - ex, C.Transform.pz[t] - ez);
        this.stop(e);
        if (tick < b.warnUntil) return;
        if (temper === "defend") {
          // A bluff: it warned, and fights only if hurt.
          b.mode = "idle";
          b.target = -1;
          b.calmUntil = tick + Math.round(this.ai.calmSeconds * this.tickHz);
          return;
        }
        b.mode = "chase";
        this.alert(e, b);
      }
    }

    if (b.mode === "idle" || (b.mode === "chase" && (b.target < 0 || !this.alive(sim, b.target)))) {
      const was = b.mode;
      let near = hurt ? this.attacker(sim, e, ex, ez, players) : -1;
      if (near < 0 && temper !== "defend") near = this.nearestLiving(players, ex, ez, notice);
      if (near < 0 && temper === "defend" && beh && beh.telegraphS > 0 && tick >= b.calmUntil && was === "idle") {
        const t = this.nearestLiving(players, ex, ez, notice);
        if (t >= 0) {
          this.startWarn(e, b, beh, t, tick);
          return;
        }
      }
      if (near >= 0) {
        b.target = near;
        if (temper === "flee") {
          b.mode = "flee";
          this.flee(e, b, tick, near);
          return;
        }
        if (beh && beh.telegraphS > 0 && !hurt && tick >= b.calmUntil) {
          this.startWarn(e, b, beh, near, tick);
          return;
        }
        b.mode = "chase";
        this.alert(e, b);
      } else if (temper === "raid" && beh?.raid && was === "idle" && tick >= b.hungryAt && this.pickRaid(b, beh.raid)) {
        b.mode = "raid";
      } else {
        b.target = -1;
        // A wanderer strolls out to wanderM, so it only heads home from beyond that.
        const homeM = beh && beh.wanderM > 0 ? Math.max(this.ai.homeRadiusM, beh.wanderM + 1) : this.ai.homeRadiusM;
        b.mode = Math.hypot(ex - b.homeX, ez - b.homeZ) > homeM ? "return" : "idle";
      }
    }

    if (b.mode === "chase") {
      const t = b.target;
      const give = temper === "territorial" && Math.hypot(C.Transform.px[t] - ex, C.Transform.pz[t] - ez) > notice * this.ai.territoryGiveUpFactor;
      if (give || Math.hypot(ex - b.homeX, ez - b.homeZ) > def.leashRadius) {
        b.mode = "return";
        b.target = -1;
      } else {
        this.chase(e, b, tick, def.attackEverySeconds, beh?.tactics === "flank");
      }
    }
    if (b.mode === "raid") this.raid(sim, e, b, def, beh!, tick);
    if (b.mode === "return") {
      const d = this.walk(e, b, tick, b.homeX, b.homeZ);
      if (d < this.ai.homeRadiusM) {
        b.mode = "idle";
        C.Health.current[e] = C.Health.max[e];
        b.lastHealth = C.Health.max[e];
        this.stop(e);
      }
    }
  }

  private startWarn(e: number, b: Brain, beh: Behavior, t: number, tick: number): void {
    const yaw = Math.atan2(C.Transform.px[t] - C.Transform.px[e], C.Transform.pz[t] - C.Transform.pz[e]);
    C.PlayerIntent.lookYaw[e] = yaw;
    b.target = t;
    b.mode = "warn";
    b.warnUntil = tick + Math.round(beh.telegraphS * this.tickHz);
    this.stop(e);
    this.opts.warn?.(e, C.Transform.px[e], C.Transform.pz[e], yaw, Math.max(b.weapon.reach * 2, 3), beh.telegraphS * 1000, tick);
  }

  /** Pack-mates near `e` take up its target (an event, not per tick). */
  private alert(e: number, b: Brain): void {
    if (b.group === 0) return;
    const ex = C.Transform.px[e];
    const ez = C.Transform.pz[e];
    for (const [m, mb] of this.brains) {
      if (m === e || mb.group !== b.group || mb.mode !== "idle" || C.Health.current[m] <= 0) continue;
      if (Math.hypot(C.Transform.px[m] - ex, C.Transform.pz[m] - ez) > this.ai.alertRadiusM) continue;
      mb.target = b.target;
      mb.mode = "chase";
    }
  }

  private attacker(sim: SimWorld, e: number, x: number, z: number, players: ArrayLike<number>): number {
    const a = this.opts.attackerOf?.(e);
    if (a !== undefined && a >= 0 && this.alive(sim, a)) return a;
    return this.nearestLiving(players, x, z, this.ai.hurtSearchRadiusM);
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

  private chase(e: number, b: Brain, tick: number, everySeconds: number, flank = false): void {
    const tx = C.Transform.px[b.target];
    const tz = C.Transform.pz[b.target];
    const dx = tx - C.Transform.px[e];
    const dz = tz - C.Transform.pz[e];
    const d = Math.hypot(dx, dz);
    C.PlayerIntent.lookYaw[e] = Math.atan2(dx, dz);
    if (d > b.weapon.reach + this.ai.reachMarginM) {
      if (flank && d > this.ai.closeInM) {
        // Swing out to this flanker's side, less as it closes: the pack arrives from both flanks.
        const off = Math.min(this.ai.flankOffsetM, d * 0.5) * b.side;
        this.walk(e, b, tick, tx - (dz / d) * off, tz + (dx / d) * off);
      } else {
        this.walk(e, b, tick, tx, tz);
      }
      return;
    }
    this.stop(e);
    if (tick >= b.nextSwing) {
      C.PlayerIntent.buttons[e] = IntentButton.Attack;
      b.nextSwing = tick + Math.round(everySeconds * this.tickHz);
    }
  }

  /** Run directly away from the threat `t`. */
  private flee(e: number, b: Brain, tick: number, t: number): void {
    const dx = C.Transform.px[e] - C.Transform.px[t];
    const dz = C.Transform.pz[e] - C.Transform.pz[t];
    const d = Math.hypot(dx, dz) || 1;
    this.walk(e, b, tick, C.Transform.px[e] + (dx / d) * 20, C.Transform.pz[e] + (dz / d) * 20);
  }

  /** Raid: choose the settlement with the best pull in range; false if none qualifies. */
  private pickRaid(b: Brain, raid: NonNullable<Behavior["raid"]>): boolean {
    const list = this.opts.settlements?.();
    if (!list) return false;
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.size < raid.minStructures) continue;
      const d = Math.hypot(s.x - b.homeX, s.z - b.homeZ);
      if (d > raid.rangeM) continue;
      // The bigger the place and the closer, the stronger the pull (smell and noise carry).
      const score = s.size / (1 + d / 500);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    b.raidIdx = best;
    b.raidFightTicks = 0;
    return best >= 0;
  }

  /**
   * Instinct, not planning: head for the settlement; once there, the target with the greatest
   * weight over distance (a player makes noise, livestock smells of food, a structure is in
   * the way); fight until sated, then go home.
   */
  private raid(sim: SimWorld, e: number, b: Brain, def: Def, beh: Behavior, tick: number): void {
    const raid = beh.raid!;
    const list = this.opts.settlements?.();
    const s = list && b.raidIdx >= 0 ? list[b.raidIdx] : undefined;
    const sated = b.raidFightTicks >= raid.satiateSeconds * this.tickHz;
    if (!s || sated || C.Health.current[e] < C.Health.max[e] * 0.25) {
      b.mode = "return"; // sated (or beaten off): back to the lair
      b.target = -1;
      b.hungryAt = tick + this.hungerTicks(def);
      b.raidIdx = -1;
      return;
    }
    const ex = C.Transform.px[e];
    const ez = C.Transform.pz[e];
    if (b.target >= 0 && !this.alive(sim, b.target)) b.target = -1;
    if (tick >= b.nextScan) {
      b.nextScan = tick + this.rescanTicks + (e % this.rescanTicks);
      b.target = this.pickTarget(sim, e, s, raid.weights, ex, ez);
    }
    if (b.target >= 0) {
      const inReach = Math.hypot(C.Transform.px[b.target] - ex, C.Transform.pz[b.target] - ez) <= b.weapon.reach + this.ai.reachMarginM;
      if (inReach) b.raidFightTicks++;
      this.chase(e, b, tick, def.attackEverySeconds);
      return;
    }
    // Nothing to fight yet: on to the settlement's heart; nothing left there and it is done.
    if (this.walk(e, b, tick, s.x, s.z) < Math.max(this.ai.homeRadiusM, s.radius * 0.25)) b.raidFightTicks++; // lingers among the empty houses a while, then has had enough
  }

  private pickTarget(sim: SimWorld, e: number, s: RaidSettlement, w: { player: number; livestock: number; structure: number }, x: number, z: number): number {
    const all = this.everything(sim.ecs);
    const reach = s.radius + 30;
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < all.length; i++) {
      const t = all[i];
      if (t === e || C.Health.current[t] <= 0) continue;
      const tx = C.Transform.px[t];
      const tz = C.Transform.pz[t];
      if (Math.hypot(tx - s.x, tz - s.z) > reach) continue;
      const other = this.brains.get(t);
      let weight: number;
      if (other) weight = this.opts.creatures[other.kind]?.behavior?.role === "livestock" ? w.livestock : 0;
      else weight = hasComponent(sim.ecs, C.CharacterRef, t) ? w.player : w.structure;
      if (weight <= 0) continue;
      const score = weight / (1 + Math.hypot(tx - x, tz - z) / 20);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  /** Aquatic: keep to the water and the depth, never swim on toward dry ground. */
  private swim(e: number, def: Def): void {
    const beh = def.behavior!;
    const mx = C.PlayerIntent.mx[e];
    const mz = C.PlayerIntent.mz[e];
    const x = C.Transform.px[e];
    const z = C.Transform.pz[e];
    const wet = this.opts.waterDepthAt;
    if (wet && (mx !== 0 || mz !== 0)) {
      const m = Math.hypot(mx, mz);
      if (wet(x + (mx / m) * this.ai.waterLookAheadM, z + (mz / m) * this.ai.waterLookAheadM) < Math.max(this.ai.minWaterM, beh.depthM?.[0] ?? 0)) {
        C.PlayerIntent.mx[e] = 0;
        C.PlayerIntent.mz[e] = 0;
      }
    }
    const surface = this.opts.waterSurfaceAt?.(x, z);
    if (surface != null) {
      const want = surface - this.depthMid(def);
      C.PlayerIntent.my[e] = Math.max(-1, Math.min(1, (want - C.Transform.py[e]) * 0.5));
    }
  }

  /** Walk toward a point (crowd-steered when running); returns the distance left. */
  /** WL2: an idle, awake creature strolls around its home within `wanderM`, pausing between strolls. */
  private wander(e: number, b: Brain, beh: Behavior, tick: number): void {
    if (Number.isNaN(b.wanderX)) {
      if (tick < b.wanderUntil) return; // pausing
      const r = beh.wanderM * Math.sqrt(this.rand());
      const a = this.rand() * 2 * Math.PI;
      b.wanderX = b.homeX + r * Math.cos(a);
      b.wanderZ = b.homeZ + r * Math.sin(a);
    }
    const d = this.walk(e, b, tick, b.wanderX, b.wanderZ, WANDER_PACE);
    if (d < 0.5) {
      b.wanderX = NaN;
      b.wanderZ = NaN;
      b.wanderUntil = tick + Math.round(beh.wanderPauseS * this.tickHz);
      this.stop(e);
      C.PlayerIntent.mx[e] = 0;
      C.PlayerIntent.mz[e] = 0;
    }
  }

  private walk(e: number, b: Brain, tick: number, x: number, z: number, pace = 1): number {
    const dx = x - C.Transform.px[e];
    const dz = z - C.Transform.pz[e];
    const d = Math.hypot(dx, dz);
    const def = this.opts.creatures[b.kind];
    if (this.opts.steer === true && C.NavAgent.state[e] !== C.NavAgentState.Invalid && def?.behavior?.habitat !== "water") {
      if (def) C.NavAgent.speed[e] = this.runSpeed(def) * this.walkSpeed * pace;
      if (tick >= b.nextGive) {
        this.give(e, x, z);
        b.nextGive = tick + this.repathTicks;
      }
    } else if (d > 1e-3) {
      const speed = def ? this.runSpeed(def) * pace : 0;
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
