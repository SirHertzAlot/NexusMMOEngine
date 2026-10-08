/**
 * StatusSystem — generic buffs and debuffs: timed, stacking, cleansing,
 * stat-modifying, damage- and heal-over-time effects.
 *
 * This is the *ability* effect layer (spells, poisons, rallying cries).
 * Bleeding (body.ts) stays the injury model — a wound is not a debuff.
 * Combat and spells apply statuses here; the rules read the modifiers
 * back through `modifier(e, stat)` when they compute a blow.
 *
 * Stacking: `maxStacks` caps; `refresh` says what a re-apply does —
 * "refresh" restarts the duration, "accumulate" adds a stack (to the cap),
 * "ignore" does nothing while active.
 *
 * Modifiers combine additively within a mode: total add = sum of adds,
 * total mul = product of (1 + mul) — so two +20% buffs give 1.44x, not
 * 1.4x. The caller applies `base * mul + add`.
 *
 * DoT/HoT tick on the status's own interval; the owner supplies the
 * damage/heal sinks so this system never touches Health directly.
 * Dispel removes every `dispellable` status at once (one cleanse action).
 * Changes (applied/removed) drain for the gateway (`drainChanges`).
 */

import type { SimWorld } from "./world.js";
import type { SimSystem } from "./systems.js";

export interface StatMod {
  /** The stat this touches ("power", "armour", "speed" — the rules' names). */
  stat: string;
  mode: "add" | "mul";
  /** add: flat amount; mul: fraction (0.2 = +20%). */
  value: number;
}

export interface OverTime {
  /** Damage (debuff) or healing (buff) per second. */
  perSecond: number;
  /** How often it lands, ms. */
  intervalMs: number;
}

export interface StatusDef {
  id: string;
  kind: "buff" | "debuff";
  /** ms; 0 means it lasts until cleansed or removed. */
  durationMs: number;
  maxStacks: number;
  refresh: "refresh" | "accumulate" | "ignore";
  /** Whether a cleanse removes it. */
  dispellable: boolean;
  mods: StatMod[];
  /** Damage over time (debuffs). */
  dot?: OverTime;
  /** Heal over time (buffs). */
  hot?: OverTime;
}

export interface ActiveStatus {
  id: string;
  kind: "buff" | "debuff";
  stacks: number;
  /** Ticks until it expires; Infinity for permanent. */
  expiresIn: number;
  source: number;
}

/** A buff/debuff gained or lost, for the gateway. */
export interface StatusChange {
  tick: number;
  entity: number;
  id: string;
  state: "applied" | "removed";
  stacks?: number;
}

interface Active {
  stacks: number;
  expiresAt: number; // Infinity for permanent
  nextTickAt: number;
  source: number;
}

const msToTicks = (ms: number, tickHz: number): number => Math.max(0, Math.round((ms / 1000) * tickHz));

export class StatusSystem implements SimSystem {
  readonly name = "status";
  private readonly defs = new Map<string, StatusDef>();
  private readonly entities = new Map<number, Map<string, Active>>();
  private changes: StatusChange[] = [];

  constructor(
    private readonly tickHz = 30,
    /** Where DoT damage goes (the owner applies it to Health). */
    private readonly damage?: (target: number, amount: number, statusId: string) => void,
    /** Where HoT healing goes. */
    private readonly heal?: (target: number, amount: number, statusId: string) => void,
  ) {}

  /** Register (or replace) a status definition. */
  define(def: StatusDef): void {
    this.defs.set(def.id, def);
  }

  /** Apply `id` to `e` from `source` at `tick`. Unknown ids are ignored. */
  apply(e: number, id: string, source: number, tick: number): boolean {
    const def = this.defs.get(id);
    if (!def) return false;
    let act = this.entities.get(e)?.get(id);
    if (act) {
      if (def.refresh === "ignore") return true;
      if (def.refresh === "accumulate") act.stacks = Math.min(def.maxStacks, act.stacks + 1);
      if (def.durationMs > 0) act.expiresAt = tick + msToTicks(def.durationMs, this.tickHz);
      act.source = source;
      this.changes.push({ tick, entity: e, id, state: "applied", stacks: act.stacks });
      return true;
    }
    let byEntity = this.entities.get(e);
    if (!byEntity) {
      byEntity = new Map();
      this.entities.set(e, byEntity);
    }
    const duration = msToTicks(def.durationMs, this.tickHz);
    const interval = def.dot ?? def.hot;
    act = {
      stacks: 1,
      expiresAt: def.durationMs > 0 ? tick + duration : Infinity,
      nextTickAt: interval ? tick + msToTicks(interval.intervalMs, this.tickHz) : Infinity,
      source,
    };
    byEntity.set(id, act);
    this.changes.push({ tick, entity: e, id, state: "applied", stacks: 1 });
    return true;
  }

  /** Remove one status, or all when `id` is omitted. Returns what was removed. */
  remove(e: number, tick: number, id?: string): string[] {
    const byEntity = this.entities.get(e);
    if (!byEntity) return [];
    const removed: string[] = [];
    if (id !== undefined) {
      if (byEntity.delete(id)) {
        removed.push(id);
        this.changes.push({ tick, entity: e, id, state: "removed" });
      }
    } else {
      for (const key of byEntity.keys()) {
        removed.push(key);
        this.changes.push({ tick, entity: e, id: key, state: "removed" });
      }
      byEntity.clear();
    }
    if (byEntity.size === 0) this.entities.delete(e);
    return removed;
  }

  /** Remove every dispellable status on `e`. Returns what was cleansed. */
  cleanse(e: number, tick: number): string[] {
    const byEntity = this.entities.get(e);
    if (!byEntity) return [];
    const removed: string[] = [];
    for (const [id] of byEntity) {
      if (this.defs.get(id)?.dispellable) {
        byEntity.delete(id);
        removed.push(id);
        this.changes.push({ tick, entity: e, id, state: "removed" });
      }
    }
    if (byEntity.size === 0) this.entities.delete(e);
    return removed;
  }

  /** Combined modifier for `stat` on `e`: `{ add, mul }`, applied as base * mul + add. */
  modifier(e: number, stat: string): { add: number; mul: number } {
    const byEntity = this.entities.get(e);
    const out = { add: 0, mul: 1 };
    if (!byEntity) return out;
    for (const [id, act] of byEntity) {
      const def = this.defs.get(id);
      if (!def) continue;
      for (const m of def.mods) {
        if (m.stat !== stat) continue;
        if (m.mode === "add") out.add += m.value * act.stacks;
        else out.mul *= Math.pow(1 + m.value, act.stacks);
      }
    }
    return out;
  }

  /** What `e` currently carries, for the client frame. */
  active(e: number, tick: number): ActiveStatus[] {
    const byEntity = this.entities.get(e);
    if (!byEntity) return [];
    const out: ActiveStatus[] = [];
    for (const [id, act] of byEntity) {
      const def = this.defs.get(id);
      if (!def) continue;
      out.push({
        id,
        kind: def.kind,
        stacks: act.stacks,
        expiresIn: act.expiresAt === Infinity ? Infinity : Math.max(0, act.expiresAt - tick),
        source: act.source,
      });
    }
    return out;
  }

  /** Changes since the last call, for the gateway. */
  drainChanges(): StatusChange[] {
    const out = this.changes;
    if (out.length > 0) this.changes = [];
    return out;
  }

  /** Forget `e` entirely (despawn): every status reads as removed. */
  forget(e: number, tick: number): void {
    const byEntity = this.entities.get(e);
    if (byEntity) {
      for (const id of byEntity.keys()) this.changes.push({ tick, entity: e, id, state: "removed" });
    }
    this.entities.delete(e);
  }

  step(sim: SimWorld, _dt: number): void {
    const tick = sim.currentTick;
    for (const [e, byEntity] of this.entities) {
      for (const [id, act] of byEntity) {
        const def = this.defs.get(id);
        if (!def) {
          byEntity.delete(id);
          this.changes.push({ tick, entity: e, id, state: "removed" });
          continue;
        }
        if (tick >= act.expiresAt) {
          byEntity.delete(id);
          this.changes.push({ tick, entity: e, id, state: "removed" });
          continue;
        }
        const ot = def.kind === "debuff" ? def.dot : def.hot;
        const sink = def.kind === "debuff" ? this.damage : this.heal;
        if (ot && sink && tick >= act.nextTickAt) {
          const ticks = msToTicks(ot.intervalMs, this.tickHz);
          sink(e, (ot.perSecond / this.tickHz) * ticks * act.stacks, id);
          act.nextTickAt += ticks;
        }
      }
      if (byEntity.size === 0) this.entities.delete(e);
    }
  }
}
