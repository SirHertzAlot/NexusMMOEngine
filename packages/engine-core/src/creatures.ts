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
import { ClipId, IntentButton, LocomotionMode } from "@mmo-engine/protocol";
import { type CreaturesRules, type ItemBaseRules, CreatureAiSchema, type CreatureAiRules } from "@mmo-engine/rules";
import { fnv1a32 } from "@mmo-engine/scatter";
import * as C from "./components.js";
import type { Weapon } from "./vocabulary.js";
import { INVALID_POOL_HANDLE, RespawnKind, SlotState, SpawnPoolSoA } from "./pools/spawn-pool-soa.js";
import { attachDefaultCollider, CHARACTER_CAPSULE, PLAYER_SPEED, type SimSystem } from "./systems.js";
import type { SystemAccess } from "./system-access.js";
import { clearOfStatics } from "./prop-collision.js";
import type { SimWorld } from "./world.js";
import { hash } from "./procgen/ecology.js";
import { LivingSimSystem } from "./sim/living-sim-system.js";
import type { SeasonClock } from "./sim/world-cycle.js";
import type { DayClock } from "@mmo-engine/protocol";

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
  /** Day clock for living simulation and seasonal cycles. */
  dayClock?: DayClock;
  /** Season clock for macro world seasonal cycles (Spring, Summer, Autumn rut, Winter dormancy). */
  seasonClock?: SeasonClock;
  /** Living simulation system (biological needs, digestion, sleep, excretion, breeding). */
  livingSim?: LivingSimSystem;
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
  /** Optional SAB SpawnPoolSoA for pool-backed creature instantiation and respawn polling. */
  pool?: SpawnPoolSoA;
  /** Optional resolver mapping `archetypeHash` -> creature kind id when polling `pool`. */
  kindResolver?: (archetypeHash: number) => string | undefined;
  /** Optional ms clock for SAB pool timestamps; defaults to tick-derived ms `(tick * 1000) / tickHz`. */
  now?: () => number;
}

/** A place raiders are drawn to. */
export interface RaidSettlement { x: number; z: number; /** Structures in it. */ size: number; /** Metres across from the centre. */ radius: number }

type Mode = "idle" | "chase" | "return" | "flee" | "warn" | "raid";

interface Brain {
  kind: string;
  slotHandle: number;
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
  /** WL2/Graze: individual wander multiplier and scout flag for natural herd dispersion. */
  wanderMultiplier: number;
  isScout?: boolean;
}

/**
 * Natural SI scale multipliers for species models.
 * Normalizes varied authored asset heights to realistic real-world SI proportions (1.0 = 1.0 m, human height = 1.80 m).
 * Deer stands ~1.76 m (matching human height); wolves stand ~0.94 m head / ~0.80 m shoulder; etc.
 */
export const SPECIES_NATURAL_SCALE: Readonly<Record<string, number>> = Object.freeze({
  deer: 0.42,
  stag: 0.48,
  elk: 0.48,
  wolf: 0.35,
  "dire-wolf": 0.50,
  fox: 0.22,
  coyote: 0.30,
  bobcat: 0.32,
  cougar: 0.55,
  "sabre-tooth": 0.65,
  bear: 1.10,
  "short-faced-bear": 1.45,
  boar: 1.00,
  horse: 0.44,
  donkey: 0.34,
  cow: 0.36,
  bull: 0.38,
  sheep: 0.34,
  goat: 0.34,
  alpaca: 0.34,
  bighorn: 0.36,
  pig: 0.70,
  rabbit: 0.45,
  hare: 0.45,
  porcupine: 0.50,
  raccoon: 0.40,
  otter: 0.38,
  squirrel: 0.35,
  quail: 0.25,
  raven: 0.30,
  hen: 0.35,
  duck: 0.35,
  frog: 0.25,
  monkey: 0.40,
  snake: 0.50,
  "giant-spider": 0.90,
  mammoth: 1.80,
  "woolly-rhino": 1.30,
  "giant-ground-sloth": 1.50,
  fish: 0.40,
  shark: 1.00,
  orca: 1.40,
  squid: 0.60,
  "giant-squid": 1.80,
  megalodon: 2.20,
});

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

/**
 * How far a pack scatters from the point it spawns at.
 *
 * `anchored` (the default) keeps a hand-placed pack at its node: a scene's
 * camp, a dungeon room, an admin spawn. `grazing` is for ambient wildlife,
 * which spreads a herd across its territory. `radiusM` overrides whichever
 * radius the mode would pick.
 */
export interface PackSpread {
  readonly mode: "anchored" | "grazing";
  readonly radiusM?: number;
}

export class CreatureSystem implements SimSystem {
  readonly name = "creatures";
  readonly access: SystemAccess = {
    system: "creatures",
    reads: [
      { component: "Animation", fields: ["clipId"] },
      "BodyConfig",
      "CharacterRef",
      { component: "Health", fields: ["current", "max"] },
      { component: "NavAgent", fields: ["seq", "state"] },
      { component: "PlayerIntent", fields: ["mx", "mz"] },
      { component: "Transform", fields: ["px", "py", "pz"] },
    ],
    writes: [
      { component: "Action", fields: ["move"] },
      { component: "Animation", fields: ["clipId", "layerMask", "rate", "startTick"] },
      { component: "AssetRef", fields: ["assetHash", "variant"] },
      "FarVisible",
      { component: "Health", fields: ["current", "max"] },
      { component: "Locomotion", fields: ["abilities", "breath", "mode"] },
      { component: "NavAgent", fields: ["seq", "speed", "tx", "ty", "tz"] },
      { component: "PlayerIntent", fields: ["buttons", "jump", "lookYaw", "mx", "my", "mz"] },
      { component: "Transform", fields: ["px", "py", "pz", "qw", "sx", "sy", "sz"] },
      { component: "Velocity", fields: ["lx", "lz"] },
    ],
  };
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
  private respawnPool: SpawnPoolSoA | undefined;
  private poolKindResolver: ((hash: number) => string | undefined) | undefined;
  private readonly poolHandleToEid = new Map<number, number>();
  private readonly hashToKind = new Map<number, string>();
  private poolScratchSlots: Int32Array | undefined;

  private readonly opts: CreatureOptions;
  readonly livingSim: LivingSimSystem;

  constructor(opts: CreatureOptions) {
    this.opts = { ...opts };
    this.rngState = opts.seed ?? 20261002;
    this.tickHz = opts.tickHz ?? 30;
    this.respawnPool = opts.pool;
    this.poolKindResolver = opts.kindResolver;
    if (opts.pool) {
      this.poolScratchSlots = new Int32Array(Math.max(64, opts.pool.capacity));
    }
    this.rebuildKindHashes();
    this.setAi(opts.ai ?? DEFAULT_AI);
    this.livingSim = opts.livingSim ?? new LivingSimSystem({
      dayClock: opts.dayClock,
      seasonClock: opts.seasonClock,
      tickHz: this.tickHz,
      waterSurfaceAt: opts.waterSurfaceAt,
      groundHeightAt: opts.groundHeightAt,
    });
  }

  private rebuildKindHashes(): void {
    this.hashToKind.clear();
    for (const k of Object.keys(this.opts.creatures)) {
      this.hashToKind.set(fnv1a32(k) >>> 0, k);
    }
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
    this.rebuildKindHashes();
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

  /** Every creature kind this world can spawn, sorted (for the admin `spawnlist`). */
  kinds(): string[] {
    return Object.keys(this.opts.creatures).sort();
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
    if (!b) return undefined;
    if (b.slotHandle !== INVALID_POOL_HANDLE && this.respawnPool?.isValidHandle(b.slotHandle)) {
      const slotDelayMs = this.respawnPool.respawnDelayMs[b.slotHandle & 0xffff]!;
      if (slotDelayMs > 0) return slotDelayMs / 1000;
    }
    return this.opts.creatures[b.kind]?.respawnSeconds;
  }

  /** Packed `SpawnPoolSoA` slot handle for creature `eid`, or `0` (`INVALID_POOL_HANDLE`) if not pool-backed. */
  poolSlotOf(eid: number): number {
    return this.brains.get(eid)?.slotHandle ?? INVALID_POOL_HANDLE;
  }

  /** Put a respawning creature back at home with a fresh brain. False if `e` is not one. */
  place(sim: SimWorld, e: number): boolean {
    const b = this.brains.get(e);
    if (!b) return false;
    const def = this.opts.creatures[b.kind];
    let fallbackY = C.Transform.py[e];
    if (b.slotHandle !== INVALID_POOL_HANDLE && this.respawnPool?.isValidHandle(b.slotHandle)) {
      const idx = b.slotHandle & 0xffff;
      b.homeX = this.respawnPool.homeX[idx]!;
      b.homeZ = this.respawnPool.homeZ[idx]!;
      fallbackY = this.respawnPool.homeY[idx]!;
      this.respawnPool.markActive(b.slotHandle, e);
      this.poolHandleToEid.set(b.slotHandle, e);
    }
    C.Transform.px[e] = b.homeX;
    C.Transform.pz[e] = b.homeZ;
    C.Transform.py[e] = this.spawnY(def, b.homeX, b.homeZ, fallbackY);
    C.Velocity.lx[e] = 0;
    C.Velocity.lz[e] = 0;
    b.mode = "idle";
    b.target = -1;
    b.lastHealth = C.Health.max[e];
    b.raidIdx = -1;
    b.wanderX = NaN;
    b.wanderZ = NaN;
    b.wanderUntil = sim.currentTick + Math.floor(this.rand() * (def?.behavior?.wanderPauseS ?? 6) * this.tickHz);
    b.hungryAt = sim.currentTick + this.hungerTicks(def);
    this.stop(e);
    return true;
  }

  /**
   * Instantiate all active `RespawnKind.Creature` slots from a `SpawnPoolSoA` into `sim`,
   * binding each `slotHandle` to the creature `Brain` and updating `liveEid` in the SAB SoA.
   * Also saves `pool`, `kindResolver`, and optional pre-allocated `scratchSlots` for zero-alloc polling.
   */
  instantiateFromPool(
    sim: SimWorld,
    pool: SpawnPoolSoA,
    kindResolver: (hash: number) => string | undefined,
    opts?: { scratchSlots?: Int32Array },
  ): number[] {
    this.respawnPool = pool;
    this.poolKindResolver = kindResolver;
    if (opts?.scratchSlots) {
      this.poolScratchSlots = opts.scratchSlots;
    } else if (!this.poolScratchSlots || this.poolScratchSlots.length < pool.capacity) {
      this.poolScratchSlots = new Int32Array(Math.max(64, pool.capacity));
    }

    const spawned: number[] = [];
    const hw = pool.highWater;
    const kindArr = pool.kind;
    const stateArr = pool.state;
    const archArr = pool.archetypeHash;
    const modelArr = pool.modelHash;
    const homeXArr = pool.homeX;
    const homeYArr = pool.homeY;
    const homeZArr = pool.homeZ;
    const group = this.nextGroup++;

    for (let i = 0; i < hw; i++) {
      if (kindArr[i] !== RespawnKind.Creature || stateArr[i] !== SlotState.Active) continue;
      const handle = pool.handleAtSlot(i);
      if (handle === INVALID_POOL_HANDLE) continue;
      const prevEid = this.poolHandleToEid.get(handle);
      if (prevEid !== undefined && entityExists(sim.ecs, prevEid) && this.brains.has(prevEid)) {
        continue;
      }
      const kind = this.resolvePoolKind(archArr[i]! >>> 0);
      if (!kind || !(kind in this.opts.creatures)) continue;

      const hx = homeXArr[i]!;
      const hy = homeYArr[i]!;
      const hz = homeZArr[i]!;
      const eid = this.spawnInternal(sim, kind, hx, hz, spawned.length, group, {
        slotHandle: handle,
        homeY: hy,
        modelHashOverride: modelArr[i]! >>> 0,
      });
      const b = this.brains.get(eid)!;
      if (b.homeX !== hx || b.homeZ !== hz) {
        pool.setHome(handle, b.homeX, C.Transform.py[eid]!, b.homeZ);
      }
      pool.markActive(handle, eid);
      this.poolHandleToEid.set(handle, eid);
      spawned.push(eid);
    }
    return spawned;
  }

  /**
   * Spawn one pack of `kind` around (x, z): a random size in the creature's
   * pack range (or `size`, a biome's own). Returns the entity ids.
   *
   * `spread` says how far from (x, z) the pack may scatter, and defaults to
   * `anchored`: a hand-placed pack stays within a few metres of the node
   * that placed it, because whoever placed a camp meant its occupants to be
   * at the camp. Ambient wildlife passes `grazing`, which spreads a herd
   * across its territory and sends one or two scouts to the perimeter.
   * `radiusM` overrides the radius either mode would pick.
   */
  spawnPack(
    sim: SimWorld,
    kind: string,
    x: number,
    z: number,
    size?: readonly [number, number],
    spread?: PackSpread,
  ): number[] {
    const def = this.opts.creatures[kind];
    if (!def) throw new Error(`unknown creature "${kind}"`);
    const [min, max] = size ?? def.pack;
    const n = min + Math.floor(this.rand() * (max - min + 1));
    const out: number[] = [];
    const group = this.nextGroup++;
    const grazing = spread?.mode === "grazing";
    // A grazing herd spreads organically across its territory; an anchored
    // pack keeps the tight 1.5-3 m clump around the point that placed it.
    const baseRadius = n <= 1
      ? 0
      : spread?.radiusM !== undefined
        ? Math.max(0, spread.radiusM)
        : grazing
          ? Math.max(5.0, Math.min(22.0, 3.5 * Math.sqrt(n)))
          : 0;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (this.rand() - 0.5) * 0.8;
      // In a grazing herd 1 or 2 individuals (index 0 in packs >= 3, and the
      // middle one from 6 up) act as scouts, venturing further out to graze
      // along the ridge or the perimeter when it feels safe. An anchored pack
      // has none: its members belong to the thing that placed them.
      const isScout = grazing && n >= 3 && (i === 0 || (n >= 6 && i === Math.floor(n / 2)));
      const r = n === 1
        ? 0
        : baseRadius > 0
          ? (isScout ? baseRadius * (1.4 + this.rand() * 0.6) : baseRadius * (0.35 + 0.65 * Math.sqrt(this.rand())))
          : 1.5 + this.rand() * 1.5;
      out.push(this.spawn(sim, kind, x + Math.cos(a) * r, z + Math.sin(a) * r, i, group, isScout));
    }
    return out;
  }

  spawn(sim: SimWorld, kind: string, x: number, z: number, index = 0, group = 0, isScout = false): number {
    return this.spawnInternal(sim, kind, x, z, index, group, undefined, isScout);
  }

  // `isScout` comes last so the pool call sites, which pass `poolMeta` positionally, keep working.
  private spawnInternal(
    sim: SimWorld,
    kind: string,
    x: number,
    z: number,
    index = 0,
    group = 0,
    poolMeta?: { slotHandle?: number; homeY?: number; modelHashOverride?: number },
    isScout = false,
  ): number {
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
    for (const c of [C.Transform, C.Velocity, C.PlayerIntent, C.Health, C.Locomotion, C.Action, C.NavAgent, C.Animation]) {
      addComponent(sim.ecs, c, eid);
    }
    const size = (beh?.size !== undefined && beh.size !== 1)
      ? beh.size
      : (SPECIES_NATURAL_SCALE[kind] ?? beh?.size ?? 1);
    C.Transform.px[eid] = x;
    C.Transform.pz[eid] = z;
    C.Transform.py[eid] = this.spawnY(def, x, z, poolMeta?.homeY ?? 0);
    C.Transform.qw[eid] = 1;
    C.Transform.sx[eid] = C.Transform.sy[eid] = C.Transform.sz[eid] = size;
    C.Health.current[eid] = C.Health.max[eid] = def.health;
    C.Locomotion.mode[eid] = aquatic ? LocomotionMode.Swim : LocomotionMode.Ground;
    C.Locomotion.abilities[eid] = 1;
    C.Locomotion.breath[eid] = 1;
    C.Action.move[eid] = 0;
    C.Animation.clipId[eid] = ClipId.Idle;
    C.Animation.startTick[eid] = 0;
    C.Animation.rate[eid] = 1;
    C.Animation.layerMask[eid] = 1;
    this.walkSpeed = sim.movement.walkSpeed;
    C.NavAgent.speed[eid] = this.runSpeed(def) * this.walkSpeed;
    C.NavAgent.tx[eid] = NaN;
    C.NavAgent.seq[eid] = 0;
    if (def.farVisible) addComponent(sim.ecs, C.FarVisible, eid);
    const look = this.opts.lookOf?.(kind);
    if (look) sim.setLook(eid, look);
    const model = this.opts.modelOf?.(kind);
    if (model) {
      addComponent(sim.ecs, C.AssetRef, eid);
      C.AssetRef.assetHash[eid] = fnv1a32(model);
      C.AssetRef.variant[eid] = 0;
    } else if (poolMeta?.modelHashOverride && poolMeta.modelHashOverride !== 0) {
      addComponent(sim.ecs, C.AssetRef, eid);
      C.AssetRef.assetHash[eid] = poolMeta.modelHashOverride;
      C.AssetRef.variant[eid] = 0;
    }
    // ColliderSystem skips entities with an AssetRef (scatter props), so a creature with a model would have no
    // body: it would never collide and the client would draw it as scenery. Give it the collider here.
    if (!hasComponent(sim.ecs, C.BodyConfig, eid)) attachDefaultCollider(sim, eid, size);
    // damageX scales the blow: damage goes as mass^massPower, so mass goes as damageX^(1/massPower).
    const mass = base.mass * Math.pow(def.damageX ?? 1, 1 / (this.opts.massPower ?? 0.5));
    this.brains.set(eid, {
      kind,
      slotHandle: poolMeta?.slotHandle ?? INVALID_POOL_HANDLE,
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
      wanderUntil: sim.currentTick + Math.floor(this.rand() * (beh?.wanderPauseS ?? 6) * this.tickHz),
      wanderMultiplier: group === 0
        ? 1.0
        : isScout
          ? 1.6 + this.rand() * 0.6
          : 0.7 + this.rand() * 0.55,
      isScout,
    });
    this.livingSim.getOrCreateState(eid, kind, x, C.Transform.py[eid], z);
    return eid;
  }

  private resolvePoolKind(archHash: number): string | undefined {
    return this.poolKindResolver?.(archHash) ?? this.hashToKind.get(archHash);
  }

  private poolNowMs(tick: number): number {
    return this.opts.now ? this.opts.now() : (tick * 1000) / this.tickHz;
  }

  private poolPollMs(tick: number): number {
    return this.opts.now ? this.opts.now() : (tick * 1000) / this.tickHz + 1e-6;
  }

  private pollPoolRespawns(sim: SimWorld): void {
    const pool = this.respawnPool;
    if (!pool) return;
    if (!this.poolScratchSlots || this.poolScratchSlots.length < pool.capacity) {
      this.poolScratchSlots = new Int32Array(Math.max(64, pool.capacity));
    }
    const readyCount = pool.pollReady(
      this.poolPollMs(sim.currentTick),
      this.poolScratchSlots,
      RespawnKind.Creature,
      false,
    );
    if (readyCount === 0) return;

    for (let i = 0; i < readyCount; i++) {
      const slotIdx = this.poolScratchSlots[i]!;
      const handle = pool.handleAtSlot(slotIdx);
      if (handle === INVALID_POOL_HANDLE) continue;
      const existingEid = this.poolHandleToEid.get(handle);
      if (existingEid !== undefined && entityExists(sim.ecs, existingEid) && this.brains.has(existingEid)) {
        // Living or corpse held by DeathSystem in this SimWorld; DeathSystem owns its respawn/place.
        continue;
      }
      const kind = this.resolvePoolKind(pool.archetypeHash[slotIdx]! >>> 0);
      if (!kind || !(kind in this.opts.creatures)) continue;
      const hx = pool.homeX[slotIdx]!;
      const hy = pool.homeY[slotIdx]!;
      const hz = pool.homeZ[slotIdx]!;
      const eid = this.spawnInternal(sim, kind, hx, hz, 0, this.nextGroup++, {
        slotHandle: handle,
        homeY: hy,
        modelHashOverride: pool.modelHash[slotIdx]! >>> 0,
      });
      const b = this.brains.get(eid)!;
      if (b.homeX !== hx || b.homeZ !== hz) {
        pool.setHome(handle, b.homeX, C.Transform.py[eid]!, b.homeZ);
      }
      pool.markActive(handle, eid);
      this.poolHandleToEid.set(handle, eid);
    }
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
    if (this.respawnPool) this.pollPoolRespawns(sim);
    if (this.brains.size === 0) return;
    if (sim.movement.walkSpeed !== this.walkSpeed) {
      // A rules reload changed the walk: every creature's speed is a share of it.
      this.walkSpeed = sim.movement.walkSpeed;
      this.setRules(this.opts.creatures, this.opts.bases);
    }
    const tick = sim.currentTick;
    this.livingSim.step(sim, 1 / this.tickHz);
    const players = this.characters(sim.ecs);
    const tod = this.opts.timeOfDay?.(tick) ?? null;
    for (const [e, b] of this.brains) {
      if (!entityExists(sim.ecs, e)) {
        if (b.slotHandle !== INVALID_POOL_HANDLE) {
          this.poolHandleToEid.delete(b.slotHandle);
          if (this.respawnPool?.isValidHandle(b.slotHandle) && this.respawnPool.liveEid[b.slotHandle & 0xffff] === e) {
            this.respawnPool.setLiveEid(b.slotHandle, -1);
          }
        }
        this.brains.delete(e);
        this.livingSim.remove(e);
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
        if (b.slotHandle !== INVALID_POOL_HANDLE && this.respawnPool?.isValidHandle(b.slotHandle)) {
          const idx = b.slotHandle & 0xffff;
          if (this.respawnPool.state[idx] === SlotState.Active) {
            const slotDelayMs = this.respawnPool.respawnDelayMs[idx]!;
            const def = this.opts.creatures[b.kind];
            const delayMs = slotDelayMs > 0 ? slotDelayMs : (def ? def.respawnSeconds * 1000 : 0);
            if (Number.isFinite(delayMs)) {
              this.respawnPool.scheduleRespawn(b.slotHandle, this.poolNowMs(tick), delayMs);
            }
          }
        }
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
      if (hurt) {
        const ls = this.livingSim.getState(e);
        if (ls && ls.action === "sleeping") {
          ls.action = "idle";
          ls.fatigue = Math.min(ls.fatigue, 0.35);
        }
      }
      // What it notices: its radius, less while asleep (outside its hours) or lying in wait.
      let notice = beh?.noticeM ?? def.aggroRadius;
      if (beh) {
        if (!isAwake(beh.activity, tod)) notice *= this.ai.asleepNotice;
        if (beh.tactics === "ambush") notice *= this.ai.ambushNotice;
      }
      this.think(sim, e, b, def, beh, notice, hurt, players, tick);
      const livingState = this.livingSim.getState(e);
      if (b.mode === "idle" && !hurt && livingState) {
        if (livingState.action === "sleeping") {
          C.PlayerIntent.mx[e] = 0;
          C.PlayerIntent.mz[e] = 0;
          this.stop(e);
          this.setLivingClip(e, ClipId.Sleep, tick);
          continue;
        }
        if (livingState.action === "bathroom") {
          C.PlayerIntent.mx[e] = 0;
          C.PlayerIntent.mz[e] = 0;
          this.stop(e);
          this.setLivingClip(e, ClipId.Bathroom, tick);
          continue;
        }
        if (livingState.action === "mating_display") {
          C.PlayerIntent.mx[e] = 0;
          C.PlayerIntent.mz[e] = 0;
          this.stop(e);
          this.setLivingClip(e, ClipId.MatingDisplay, tick);
          continue;
        }
        if (livingState.action === "drinking") {
          C.PlayerIntent.mx[e] = 0;
          C.PlayerIntent.mz[e] = 0;
          this.stop(e);
          this.setLivingClip(e, ClipId.Drink, tick);
          continue;
        }
        if (livingState.action === "entertaining") {
          C.PlayerIntent.mx[e] = 0;
          C.PlayerIntent.mz[e] = 0;
          this.stop(e);
          this.setLivingClip(e, ClipId.SocialPlay, tick);
          continue;
        }
        if (livingState.action === "seeking_shelter") {
          const distToShelter = Math.hypot(livingState.shelterX - C.Transform.px[e], livingState.shelterZ - C.Transform.pz[e]);
          if (distToShelter > 3.0) {
            this.setLivingClip(e, ClipId.Idle, tick);
            this.walk(e, b, tick, livingState.shelterX, livingState.shelterZ, 0.75);
          } else {
            C.PlayerIntent.mx[e] = 0;
            C.PlayerIntent.mz[e] = 0;
            this.stop(e);
            this.setLivingClip(e, ClipId.Sleep, tick);
          }
          continue;
        }
        if (livingState.action === "foraging") {
          if (tick % 60 < 35) {
            C.PlayerIntent.mx[e] = 0;
            C.PlayerIntent.mz[e] = 0;
            this.stop(e);
            this.setLivingClip(e, ClipId.Graze, tick);
            continue;
          }
        }
      }
      this.setLivingClip(e, ClipId.Idle, tick);
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

  /** WL2: an idle, awake creature strolls around its home within `wanderM`, pausing between strolls. */
  private wander(e: number, b: Brain, beh: Behavior, tick: number): void {
    if (Number.isNaN(b.wanderX)) {
      if (tick < b.wanderUntil) return; // pausing
      const baseWanderM = beh.wanderM > 0 ? beh.wanderM : (b.group > 0 ? 14 : 0);
      if (baseWanderM <= 0) return;
      const wanderRadius = baseWanderM * (b.wanderMultiplier ?? 1.0);
      const r = wanderRadius * Math.sqrt(this.rand());
      const a = this.rand() * 2 * Math.PI;
      b.wanderX = b.homeX + r * Math.cos(a);
      b.wanderZ = b.homeZ + r * Math.sin(a);
    }
    const d = this.walk(e, b, tick, b.wanderX, b.wanderZ, WANDER_PACE);
    if (d < 0.5) {
      b.wanderX = NaN;
      b.wanderZ = NaN;
      const pauseBase = beh.wanderPauseS > 0 ? beh.wanderPauseS : 6;
      const pauseMult = 0.5 + this.rand() * 1.0;
      b.wanderUntil = tick + Math.round(pauseBase * pauseMult * this.tickHz);
      this.stop(e);
      C.PlayerIntent.mx[e] = 0;
      C.PlayerIntent.mz[e] = 0;
    }
  }

  /** Walk toward a point (crowd-steered when running); returns the distance left. */
  private walk(e: number, b: Brain, tick: number, x: number, z: number, pace = 1): number {
    const dx = x - C.Transform.px[e];
    const dz = z - C.Transform.pz[e];
    const d = Math.hypot(dx, dz);
    const def = this.opts.creatures[b.kind];
    const crowdValid = this.opts.steer === true &&
      C.NavAgent.state[e] !== C.NavAgentState.Invalid &&
      C.NavAgent.state[e] !== C.NavAgentState.NoPath &&
      def?.behavior?.habitat !== "water";
    if (crowdValid) {
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

  private setLivingClip(e: number, clipId: number, tick: number): void {
    const cur = C.Animation.clipId[e];
    if (cur === clipId) return;
    if (clipId === ClipId.Idle && (cur < ClipId.Graze || cur > ClipId.SocialPlay || cur === ClipId.DeathFall)) {
      return;
    }
    C.Animation.clipId[e] = clipId;
    C.Animation.startTick[e] = tick;
    C.Animation.rate[e] = 1;
    C.Animation.layerMask[e] = 1;
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
