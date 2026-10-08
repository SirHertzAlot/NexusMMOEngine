/**
 * TelegraphSystem — server-authoritative danger zones. A caster (often a
 * boss or a siege engine) announces a shaped attack: the gateway shows the
 * warning, and when the timer runs out the blow lands on everyone still
 * inside. What the client draws is presentation; *who gets hit* is decided
 * here, on the tick, from authoritative positions.
 *
 * Shapes live on the ground plane (XZ): circles, cones, and rectangles.
 * A telegraph has two moments: `warnedAt` (the gateway event goes out —
 * "get out of the red") and `hitAt` (resolution). Cancelling (the caster
 * died, was stunned) emits a cancelled event instead of resolving.
 *
 * Damage is a hook: the owner computes it (usually the rules'
 * computeDamage for the caster's weapon, or a fixed amount). Targets are
 * every living non-god entity with Health inside the shape — the same
 * targeting contract as CombatSystem's strikes.
 */

import { defineQuery, hasComponent } from "bitecs";
import { God, Health, Transform } from "./components.js";
import type { SimWorld } from "./world.js";

export type TelegraphShape =
  | { kind: "circle"; x: number; z: number; r: number }
  | { kind: "cone"; x: number; z: number; yaw: number; range: number; halfAngle: number }
  | { kind: "rect"; x: number; z: number; yaw: number; length: number; width: number };

export interface TelegraphSpec {
  source: number;
  shape: TelegraphShape;
  /** ms of warning before it lands. */
  warnMs: number;
  /** Fixed damage; when `damageOf` is set it wins. */
  amount: number;
  /** Per-target damage (the rules' computeDamage, usually). */
  damageOf?: (target: number) => number;
}

export interface TelegraphEvent {
  tick: number;
  id: number;
  source: number;
  shape: TelegraphShape;
  state: "warned" | "resolved" | "cancelled";
  /** Warned: ticks until it lands. Resolved: targets hit. */
  ticksUntilHit?: number;
  hits?: { target: number; amount: number }[];
}

interface Live {
  spec: TelegraphSpec;
  warnedAt: number;
  hitAt: number;
}

const msToTicks = (ms: number, tickHz: number): number => Math.max(0, Math.round((ms / 1000) * tickHz));

/** Is the point (x, z) inside the shape? */
export function inShape(shape: TelegraphShape, x: number, z: number): boolean {
  const dx = x - shape.x;
  const dz = z - shape.z;
  switch (shape.kind) {
    case "circle":
      return dx * dx + dz * dz <= shape.r * shape.r;
    case "cone": {
      const d = Math.hypot(dx, dz);
      if (d > shape.range) return false;
      if (d < 1e-6) return true;
      const fx = Math.sin(shape.yaw);
      const fz = Math.cos(shape.yaw);
      return (dx * fx + dz * fz) / d >= Math.cos(shape.halfAngle);
    }
    case "rect": {
      // Into the rect's local frame: length along facing, width across.
      const fx = Math.sin(shape.yaw);
      const fz = Math.cos(shape.yaw);
      const along = dx * fx + dz * fz;
      const across = dx * fz - dz * fx;
      return along >= 0 && along <= shape.length && Math.abs(across) <= shape.width / 2;
    }
  }
}

export class TelegraphSystem {
  readonly name = "telegraph";
  private readonly query = defineQuery([Transform, Health]);
  private readonly live = new Map<number, Live>();
  private nextId = 1;
  private events: TelegraphEvent[] = [];

  constructor(private readonly tickHz = 30) {}

  /** Announce a telegraph at `tick`; the warn event drains for the gateway. */
  cast(sim: SimWorld, spec: TelegraphSpec, tick: number): number {
    const id = this.nextId++;
    const warn = msToTicks(spec.warnMs, this.tickHz);
    this.live.set(id, { spec, warnedAt: tick, hitAt: tick + warn });
    this.events.push({ tick, id, source: spec.source, shape: spec.shape, state: "warned", ticksUntilHit: warn });
    return id;
  }

  /** Cancel before it lands (caster died or was stunned). */
  cancel(id: number, tick: number): boolean {
    const live = this.live.get(id);
    if (!live) return false;
    this.live.delete(id);
    this.events.push({ tick, id, source: live.spec.source, shape: live.spec.shape, state: "cancelled" });
    return true;
  }

  /** Cancel every telegraph from `source` (it died). Returns the count. */
  cancelFrom(source: number, tick: number): number {
    let n = 0;
    for (const [id, live] of this.live) {
      if (live.spec.source === source) {
        this.live.delete(id);
        this.events.push({ tick, id, source, shape: live.spec.shape, state: "cancelled" });
        n++;
      }
    }
    return n;
  }

  step(sim: SimWorld, tick: number): void {
    for (const [id, live] of this.live) {
      if (tick < live.hitAt) continue;
      this.live.delete(id);
      const hits: { target: number; amount: number }[] = [];
      const ids = this.query(sim.ecs);
      for (let i = 0; i < ids.length; i++) {
        const t = ids[i] as number;
        if (t === live.spec.source || Health.current[t] <= 0) continue;
        if (hasComponent(sim.ecs, God, t)) continue;
        if (!inShape(live.spec.shape, Transform.px[t], Transform.pz[t])) continue;
        const amount = live.spec.damageOf ? live.spec.damageOf(t) : live.spec.amount;
        if (amount > 0) {
          Health.current[t] = Math.max(0, Health.current[t] - amount);
          hits.push({ target: t, amount });
        }
      }
      this.events.push({ tick, id, source: live.spec.source, shape: live.spec.shape, state: "resolved", hits });
    }
  }

  /** Events since the last call, for the gateway. */
  drainEvents(): TelegraphEvent[] {
    const out = this.events;
    if (out.length > 0) this.events = [];
    return out;
  }
}
