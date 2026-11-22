/**
 * DeathSystem — what happens when Health reaches 0 (M2b).
 *
 * A body at 0 health is dead: its move ends, its walk stops, and the death
 * is queued for the gateway (`drainEvents`, the 0x17 `life` message) with
 * the rules' onDeath outcome deciding the respawn delay. When that delay is
 * up the body is brought back at full health (`place` puts players at the
 * spawn point; anything else rises where it fell) and onRespawn is told.
 * Runs right after CombatSystem (and BodySystem), so a blow's death shows
 * the same tick. With a body, the cause is the body's (a vital part, blood
 * loss), and onRespawn's outcome clears its injuries.
 *
 * A duelist felled by their opponent does not die (M5): the duel ends by
 * first blood and the loser is put right where they stand, with no
 * penalty, drop or respawn delay.
 */

import { defineQuery, entityExists, hasComponent, Not } from "bitecs";
import type { DeathInput, DeathOutcome, RespawnOutcome, RuleHooks } from "@mmo-engine/rules";
import { Action, Breakable, Health, PlayerIntent, Transform, Velocity } from "./components.js";
import { INVALID_POOL_HANDLE, RespawnKind, SlotState, SpawnPoolSoA } from "./pools/spawn-pool-soa.js";
import type { SimSystem } from "./systems.js";
import type { SystemAccess } from "./system-access.js";
import type { SimWorld } from "./world.js";
import type { DuelSystem } from "./duel.js";

/** A death or a respawn, for the gateway to tell clients. */
export interface LifeEvent {
  tick: number;
  target: number;
  state: "dead" | "alive";
  killer?: number;
  /** Tick the body respawns (dead events). */
  respawnAt?: number;
  outcome?: DeathOutcome;
  /** Where it fell (dead events). */
  x?: number;
  z?: number;
  /** What killed it (dead events). */
  cause?: DeathInput;
}

/** What DeathSystem asks of the body (M2): why it died, and putting it right on respawn. */
export interface DeathBody {
  causeOf(e: number): DeathInput;
  respawned(sim: SimWorld, e: number, outcome: RespawnOutcome): void;
}

/** Options for wiring DeathSystem onto a SpawnPoolSoA. */
export interface DeathRespawnPoolOptions {
  pool: SpawnPoolSoA;
  /** Resolve the packed SAB pool handle for entity `e` (0/undefined if not pool-backed). */
  slotOf?: (e: number) => number | undefined;
  /** Optional ms clock for SAB pool timestamps; defaults to tick-derived ms `(tick * 1000) / tickHz`. */
  now?: () => number;
}

/**
 * Helper binding entity ids to `SpawnPoolSoA` slot handles for zero-alloc
 * death/respawn scheduling in `DeathSystem`.
 */
export class DeathRespawnPool {
  readonly pool: SpawnPoolSoA;
  readonly slotOf?: (e: number) => number | undefined;
  readonly now?: () => number;
  private readonly eidToSlot = new Map<number, number>();

  constructor(pool: SpawnPoolSoA, opts?: { slotOf?: (e: number) => number | undefined; now?: () => number }) {
    this.pool = pool;
    this.slotOf = opts?.slotOf;
    this.now = opts?.now;
  }

  bind(eid: number, handle: number): void {
    if (handle !== INVALID_POOL_HANDLE) this.eidToSlot.set(eid, handle);
  }

  unbind(eid: number): void {
    this.eidToSlot.delete(eid);
  }

  resolve(eid: number): number {
    const h = this.slotOf?.(eid);
    if (h !== undefined && this.pool.isValidHandle(h)) return h;
    const mapped = this.eidToSlot.get(eid);
    if (mapped !== undefined && this.pool.isValidHandle(mapped)) return mapped;
    // Fallback on infrequent death event: scan SAB liveEid column once
    const hw = this.pool.highWater;
    const live = this.pool.liveEid;
    for (let i = 0; i < hw; i++) {
      if (live[i] === eid) {
        const found = this.pool.handleAtSlot(i);
        if (found !== INVALID_POOL_HANDLE) {
          this.eidToSlot.set(eid, found);
          return found;
        }
      }
    }
    return INVALID_POOL_HANDLE;
  }
}

interface Corpse {
  respawnAt: number;
  outcome: DeathOutcome;
  inPool: boolean;
  poolHandle: number;
  poolSlotIdx: number;
}

export class DeathSystem implements SimSystem {
  readonly name = "death";
  readonly access: SystemAccess = {
    system: "death",
    reads: [
      "Action",
      "PlayerIntent",
      { component: "Health", fields: ["current", "max"] },
      { component: "Transform", fields: ["px", "pz"] },
    ],
    writes: [
      { component: "Action", fields: ["move"] },
      { component: "Health", fields: ["current"] },
      { component: "PlayerIntent", fields: ["buttons"] },
      { component: "Velocity", fields: ["lx", "lz"] },
    ],
    excludes: ["Breakable"],
  };
  private readonly bodies = defineQuery([Transform, Health, Not(Breakable)]);
  private readonly dead = new Map<number, Corpse>();
  private readonly deadEids: number[] = [];
  private readonly poolSlotDead = new Map<number, number>();
  private readonly poolHelper: DeathRespawnPool | undefined;
  private readonly readyScratch: Int32Array;
  private events: LifeEvent[] = [];

  constructor(
    private readonly hooks: RuleHooks,
    private readonly tickHz = 30,
    /** The last entity to damage `e`, if known. */
    private readonly lastAttacker?: (e: number) => number | undefined,
    /** Put a respawning body down; return false to let it rise where it fell. */
    private readonly place?: (sim: SimWorld, e: number) => boolean,
    /** Respawn delay in seconds for `e` where it differs from the rules' (creatures); undefined keeps the rules'. */
    private readonly delayOf?: (e: number) => number | undefined,
    /** Called as each death is recorded (loot drops); the event is also queued for `drainEvents`. */
    private readonly onDeath?: (sim: SimWorld, ev: LifeEvent) => void,
    /** Body parts (M2): the cause of death, and injuries cleared on respawn. Absent: a torso death. */
    private readonly body?: DeathBody,
    /** Duels (M5): a duelist felled by their opponent loses the duel instead of dying. */
    private readonly duels?: Pick<DuelSystem, "wasDuelDeath" | "opponent" | "checkBlood">,
    /** Optional resolver for entity -> SpawnPoolSoA handle, or a DeathRespawnPool/SpawnPoolSoA directly. */
    slotOfOrPool?: ((e: number) => number | undefined) | DeathRespawnPool | DeathRespawnPoolOptions | SpawnPoolSoA,
    /** Optional 10th param: SAB SpawnPoolSoA (or DeathRespawnPool helper) for zero-alloc respawn scheduling. */
    respawnPool?: SpawnPoolSoA | DeathRespawnPool | DeathRespawnPoolOptions,
  ) {
    const slotFn = typeof slotOfOrPool === "function" ? slotOfOrPool : undefined;
    const poolArg = respawnPool ?? (typeof slotOfOrPool !== "function" ? slotOfOrPool : undefined);
    if (poolArg instanceof DeathRespawnPool) {
      this.poolHelper =
        slotFn && !poolArg.slotOf
          ? new DeathRespawnPool(poolArg.pool, { slotOf: slotFn, now: poolArg.now })
          : poolArg;
    } else if (poolArg instanceof SpawnPoolSoA) {
      this.poolHelper = new DeathRespawnPool(poolArg, slotFn ? { slotOf: slotFn } : undefined);
    } else if (poolArg !== undefined) {
      this.poolHelper = new DeathRespawnPool(poolArg.pool, {
        slotOf: poolArg.slotOf ?? slotFn,
        now: poolArg.now,
      });
    } else {
      this.poolHelper = undefined;
    }
    this.readyScratch = this.poolHelper
      ? new Int32Array(Math.max(256, this.poolHelper.pool.capacity))
      : new Int32Array(0);
  }

  /** Bind entity `eid` to a `SpawnPoolSoA` packed handle (if `respawnPool` is configured). */
  bindPoolSlot(eid: number, handle: number): void {
    this.poolHelper?.bind(eid, handle);
  }

  /** Unbind entity `eid` from the `SpawnPoolSoA` slot map. */
  unbindPoolSlot(eid: number): void {
    this.poolHelper?.unbind(eid);
  }

  isDead(e: number): boolean {
    return this.dead.has(e);
  }

  /** The deaths and respawns since the last call. */
  drainEvents(): LifeEvent[] {
    const out = this.events;
    if (out.length > 0) this.events = [];
    return out;
  }

  step(sim: SimWorld): void {
    const tick = sim.currentTick;
    const ids = this.bodies(sim.ecs);
    if (this.deadEids.length > 0) {
      for (let i = this.deadEids.length - 1; i >= 0; i--) {
        const e = this.deadEids[i]!;
        if (
          !entityExists(sim.ecs, e) ||
          !hasComponent(sim.ecs, Transform, e) ||
          !hasComponent(sim.ecs, Health, e) ||
          hasComponent(sim.ecs, Breakable, e)
        ) {
          const corpse = this.dead.get(e);
          if (corpse && corpse.poolSlotIdx >= 0) this.poolSlotDead.delete(corpse.poolSlotIdx);
          this.dead.delete(e);
          const last = this.deadEids.length - 1;
          if (i !== last) this.deadEids[i] = this.deadEids[last]!;
          this.deadEids.pop();
        }
      }
    }
    if (this.poolHelper && this.poolSlotDead.size > 0) {
      const pool = this.poolHelper.pool;
      const pollMs = this.poolHelper.now ? this.poolHelper.now() : (tick * 1000) / this.tickHz + 1e-6;
      const readyCount = pool.pollReady(pollMs, this.readyScratch, RespawnKind.Creature, false);
      for (let i = 0; i < readyCount; i++) {
        const slotIdx = this.readyScratch[i]!;
        const e = this.poolSlotDead.get(slotIdx);
        if (e === undefined) continue;
        const corpse = this.dead.get(e);
        if (!corpse) {
          this.poolSlotDead.delete(slotIdx);
          continue;
        }
        this.respawn(sim, e, tick, corpse);
      }
    }
    for (let i = 0; i < ids.length; i++) {
      const e = ids[i] as number;
      const corpse = this.dead.get(e);
      if (corpse) {
        Velocity.lx[e] = 0;
        Velocity.lz[e] = 0;
        if (!corpse.inPool && tick >= corpse.respawnAt) this.respawn(sim, e, tick, corpse);
        continue;
      }
      if (Health.current[e] > 0) continue;
      const killer = this.lastAttacker?.(e);
      if (killer !== undefined && this.duels?.wasDuelDeath(e) && this.duels.opponent(e) === killer) {
        this.duels.checkBlood(e, 0, tick);
        Health.current[e] = Health.max[e];
        this.body?.respawned(sim, e, { clearInjuries: true, restoreParts: true });
        continue;
      }
      const cause: DeathInput = this.body?.causeOf(e) ?? { cause: "part", part: "torso" };
      const outcome = this.hooks.onDeath(cause);
      const poolHelper = this.poolHelper;
      const handle = poolHelper ? poolHelper.resolve(e) : INVALID_POOL_HANDLE;
      let respawnAt: number;
      let scheduledInPool = false;
      let poolSlotIdx = -1;
      let immediateRespawn = false;

      if (
        poolHelper &&
        handle !== INVALID_POOL_HANDLE &&
        poolHelper.pool.state[handle & 0xffff] === SlotState.CooldownRespawn &&
        Number.isFinite(poolHelper.pool.respawnAtMs[handle & 0xffff]!)
      ) {
        const slotIdx = handle & 0xffff;
        const nowMs = poolHelper.now ? poolHelper.now() : (tick * 1000) / this.tickHz;
        const remSec = Math.max(0, (poolHelper.pool.respawnAtMs[slotIdx]! - nowMs) / 1000);
        respawnAt = tick + Math.round(remSec * this.tickHz);
        scheduledInPool = true;
        poolSlotIdx = slotIdx;
        this.poolSlotDead.set(slotIdx, e);
        immediateRespawn = remSec <= 0;
      } else {
        let delay = this.delayOf?.(e);
        if (delay === undefined && poolHelper && handle !== INVALID_POOL_HANDLE) {
          const slotDelayMs = poolHelper.pool.respawnDelayMs[handle & 0xffff]!;
          if (slotDelayMs > 0) delay = slotDelayMs / 1000;
        }
        if (delay === undefined) delay = outcome.respawnInSeconds;
        respawnAt = tick + Math.round(delay * this.tickHz);
        if (poolHelper && handle !== INVALID_POOL_HANDLE && Number.isFinite(delay)) {
          const nowMs = poolHelper.now ? poolHelper.now() : (tick * 1000) / this.tickHz;
          if (poolHelper.pool.scheduleRespawn(handle, nowMs, Math.max(0, delay * 1000))) {
            scheduledInPool = true;
            poolSlotIdx = handle & 0xffff;
            this.poolSlotDead.set(poolSlotIdx, e);
          }
        }
      }

      const corpseRec: Corpse = {
        respawnAt,
        outcome,
        inPool: scheduledInPool,
        poolHandle: scheduledInPool ? handle : INVALID_POOL_HANDLE,
        poolSlotIdx,
      };
      this.dead.set(e, corpseRec);
      this.deadEids.push(e);
      if (hasComponent(sim.ecs, Action, e)) Action.move[e] = 0;
      Velocity.lx[e] = 0;
      Velocity.lz[e] = 0;
      const ev: LifeEvent = {
        tick,
        target: e,
        state: "dead",
        killer,
        respawnAt,
        outcome,
        x: Transform.px[e],
        z: Transform.pz[e],
        cause,
      };
      this.events.push(ev);
      this.onDeath?.(sim, ev);
      if (immediateRespawn) this.respawn(sim, e, tick, corpseRec);
    }
  }

  private respawn(sim: SimWorld, e: number, tick: number, corpse: Corpse): void {
    this.dead.delete(e);
    const idx = this.deadEids.indexOf(e);
    if (idx !== -1) {
      const last = this.deadEids.length - 1;
      if (idx !== last) this.deadEids[idx] = this.deadEids[last]!;
      this.deadEids.pop();
    }
    if (corpse.inPool && this.poolHelper) {
      if (corpse.poolSlotIdx >= 0) this.poolSlotDead.delete(corpse.poolSlotIdx);
      this.poolHelper.pool.markActive(corpse.poolHandle, e);
    }
    const back = this.hooks.onRespawn({ outcome: corpse.outcome });
    Health.current[e] = Health.max[e];
    this.body?.respawned(sim, e, back);
    if (hasComponent(sim.ecs, PlayerIntent, e)) PlayerIntent.buttons[e] = 0;
    this.place?.(sim, e);
    this.events.push({ tick, target: e, state: "alive" });
  }
}
