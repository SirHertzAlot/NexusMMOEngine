/**
 * AbilitySystem — the generic trigger layer underneath every ability:
 * melee moves, spells, item uses. It decides *when* an ability may fire;
 * the caller decides what firing does.
 *
 * Three mechanisms, all server-side and tick-based:
 * - Global cooldown (GCD): firing anything locks every ability for
 *   `gcdMs`. Mashing during the GCD queues (one deep, latest wins) —
 *   the WoW feel — instead of dropping the press.
 * - Per-ability cooldowns: each ability has its own ready-at tick.
 * - Casts: abilities with `castMs > 0` enter a casting state; anything
 *   may `interrupt` them (movement does, via the caller). An interrupted
 *   cast costs nothing and fires nothing.
 *
 * Time is ticks (30Hz default). Events drain for the gateway
 * (`drainEvents`): casting, queued, fired, interrupted, rejected.
 *
 * Runs wherever the owner steps it; it needs no components and holds no
 * per-tick allocations beyond the event list.
 */

export interface AbilityDef {
  id: string;
  /** Global cooldown triggered by firing, ms. */
  gcdMs: number;
  /** This ability's own cooldown, ms. */
  cooldownMs: number;
  /** Cast time, ms; 0 means instant. */
  castMs: number;
}

export type TriggerResult = "fired" | "queued" | "rejected";
export type AbilityState = "casting" | "queued" | "fired" | "interrupted" | "rejected";

export interface AbilityEvent {
  tick: number;
  entity: number;
  id: string;
  state: AbilityState;
  /** Why a trigger was rejected ("cooldown", "unknown"). */
  reason?: string;
}

interface EntityState {
  /** Tick the GCD clears (inclusive: trigger allowed when tick >= gcdUntil). */
  gcdUntil: number;
  /** Ability id -> tick it is ready again. */
  cooldowns: Map<string, number>;
  /** One-deep queue: the ability waiting for the GCD/cast. */
  queued?: string;
  /** A cast in progress. */
  casting?: { id: string; endsAt: number };
}

const msToTicks = (ms: number, tickHz: number): number => Math.max(0, Math.round((ms / 1000) * tickHz));

export class AbilitySystem {
  readonly name = "abilities";
  private readonly defs = new Map<string, AbilityDef>();
  private readonly entities = new Map<number, EntityState>();
  private events: AbilityEvent[] = [];

  constructor(
    private readonly tickHz = 30,
    /** The owner fires the ability's actual effect here. */
    private readonly onFire?: (e: number, id: string, tick: number) => void,
  ) {}

  /** Register (or replace) an ability definition. */
  define(def: AbilityDef): void {
    this.defs.set(def.id, def);
  }

  private state(e: number): EntityState {
    let s = this.entities.get(e);
    if (!s) {
      s = { gcdUntil: 0, cooldowns: new Map() };
      this.entities.set(e, s);
    }
    return s;
  }

  /**
   * Try to trigger `id` for `e` at `tick`. Fires now when free; queues when
   * the GCD is running or a cast is under way; rejects unknown ids and
   * abilities still on cooldown.
   */
  trigger(e: number, id: string, tick: number): TriggerResult {
    const def = this.defs.get(id);
    if (!def) {
      this.events.push({ tick, entity: e, id, state: "rejected", reason: "unknown" });
      return "rejected";
    }
    const s = this.state(e);
    if ((s.cooldowns.get(id) ?? 0) > tick) {
      this.events.push({ tick, entity: e, id, state: "rejected", reason: "cooldown" });
      return "rejected";
    }
    if (tick < s.gcdUntil || s.casting) {
      s.queued = id; // one deep: the latest press wins
      this.events.push({ tick, entity: e, id, state: "queued" });
      return "queued";
    }
    this.begin(e, def, s, tick);
    return "fired";
  }

  /** Stop `e`'s cast (movement, stun). Costs nothing, fires nothing. */
  interrupt(e: number, tick: number): boolean {
    const s = this.entities.get(e);
    if (!s?.casting) return false;
    this.events.push({ tick, entity: e, id: s.casting.id, state: "interrupted" });
    s.casting = undefined;
    return true;
  }

  /** Forget `e` entirely (despawn). */
  forget(e: number): void {
    this.entities.delete(e);
  }

  /** Ticks until `id` is ready for `e` (0 when ready now). */
  cooldownLeft(e: number, id: string, tick: number): number {
    const s = this.entities.get(e);
    return Math.max(0, (s?.cooldowns.get(id) ?? 0) - tick);
  }

  /** Ticks until the GCD clears for `e` (0 when clear). */
  gcdLeft(e: number, tick: number): number {
    const s = this.entities.get(e);
    return Math.max(0, (s?.gcdUntil ?? 0) - tick);
  }

  step(tick: number): void {
    for (const [e, s] of this.entities) {
      if (s.casting && tick >= s.casting.endsAt) {
        const def = this.defs.get(s.casting.id)!;
        s.casting = undefined;
        this.resolve(e, def, s, tick);
      } else if (!s.casting && s.queued !== undefined && tick >= s.gcdUntil) {
        const id = s.queued;
        s.queued = undefined;
        const def = this.defs.get(id);
        if (def && (s.cooldowns.get(id) ?? 0) <= tick) this.begin(e, def, s, tick);
        // A queued ability that went on cooldown meanwhile simply fizzles;
        // the client already heard "queued" and hears nothing more.
      }
    }
  }

  /** Start the ability: a cast enters casting, an instant resolves now. */
  private begin(e: number, def: AbilityDef, s: EntityState, tick: number): void {
    if (msToTicks(def.castMs, this.tickHz) > 0) {
      s.casting = { id: def.id, endsAt: tick + msToTicks(def.castMs, this.tickHz) };
      this.events.push({ tick, entity: e, id: def.id, state: "casting" });
    } else {
      this.resolve(e, def, s, tick);
    }
  }

  /** The ability goes off: GCD + cooldown start, the owner is told. */
  private resolve(e: number, def: AbilityDef, s: EntityState, tick: number): void {
    const gcd = msToTicks(def.gcdMs, this.tickHz);
    const cd = msToTicks(def.cooldownMs, this.tickHz);
    s.gcdUntil = tick + gcd;
    if (cd > 0) s.cooldowns.set(def.id, tick + cd);
    this.events.push({ tick, entity: e, id: def.id, state: "fired" });
    this.onFire?.(e, def.id, tick);
  }

  /** Events since the last call, for the gateway. */
  drainEvents(): AbilityEvent[] {
    const out = this.events;
    if (out.length > 0) this.events = [];
    return out;
  }
}
