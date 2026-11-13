/**
 * Combat numbers (roadmap CF2): damage floaters as a pipeline, not a trick.
 *
 *   hit event -> CLASSIFY (type, magnitude, emphasis)
 *             -> ARBITRATE (merge into the target's open floater, else a lane)
 *             -> SPAWN (pooled floater) -> ANIMATE (birth pop, rise, arc, fade)
 *             -> RETIRE (back to the pool)
 *
 * Everything tunable is the recipe (data). Presentation only: the server
 * decides damage, this renders its events. Floaters are preallocated; a
 * start allocates nothing. Budgets: `maxPerTarget` folds extra hits into the
 * target's open floater, and `maxGlobal` stops spawning (the player's own
 * hits always get a floater, taking the oldest one's slot if need be).
 */

import type { HitMessage } from "@mmo-engine/protocol";
import { MotionSystem, makeOut, noise, type MotionOut, type Recipe } from "../motion/index.js";

export type NumberKind = "damage" | "heavy" | "block" | "miss";

export interface NumbersRecipe {
  lifetimeMs: number;
  /** Screen px/s upward, and px/s^2 pulling it back down (the arc). */
  rise: number;
  gravity: number;
  /** Fade starts at this share of the lifetime. */
  fadeStart: number;
  /** Birth motion (Motion Grammar). */
  birth: Recipe;
  magnitude: { referenceValue: number; minScale: number; maxScale: number };
  types: Record<NumberKind, { color: string; prefix: string; scaleMul: number }>;
  /** A blow this share of the target's max health is `heavy`. */
  heavyShare: number;
  heavy: { tiltDeg: number; shake: number };
  accumulate: { windowMs: number };
  lanes: { count: number; spacing: number };
  budgets: { maxPerTarget: number; maxGlobal: number };
}

export const DEFAULT_NUMBERS: NumbersRecipe = {
  lifetimeMs: 900,
  rise: 70,
  gravity: 60,
  fadeStart: 0.55,
  birth: { steps: [{ p: "pop", ms: 110, overshoot: 1.35, from: 0.4 }] },
  magnitude: { referenceValue: 100, minScale: 0.8, maxScale: 1.9 },
  types: {
    damage: { color: "#ffe9a8", prefix: "", scaleMul: 1 },
    heavy: { color: "#ff5b4a", prefix: "", scaleMul: 1.25 },
    block: { color: "#9aa7b5", prefix: "", scaleMul: 0.8 },
    miss: { color: "#9aa7b5", prefix: "", scaleMul: 0.7 },
  },
  heavyShare: 0.25,
  heavy: { tiltDeg: -8, shake: 3 },
  accumulate: { windowMs: 250 },
  lanes: { count: 3, spacing: 26 },
  budgets: { maxPerTarget: 6, maxGlobal: 64 },
};

export interface Floater {
  live: boolean;
  target: bigint;
  kind: NumberKind;
  /** Summed value (damage) or 0 (miss). */
  value: number;
  text: string;
  /** Font scale from the magnitude map and type. */
  scale: number;
  color: string;
  lane: number;
  /** Lane offset from the anchor, px. */
  laneX: number;
  /** Age in ms, and the last time a hit merged into it. */
  age: number;
  mergedAt: number;
  motion: number;
  seed: number;
  mine: boolean;
  /** The result of animate(): screen offset from the anchor, px, alpha, scale, tilt. */
  x: number;
  y: number;
  alpha: number;
  s: number;
  rot: number;
}

const blank = (): Floater => ({
  live: false, target: 0n, kind: "damage", value: 0, text: "", scale: 1, color: "", lane: 0, laneX: 0,
  age: 0, mergedAt: 0, motion: -1, seed: 0, mine: false, x: 0, y: 0, alpha: 1, s: 1, rot: 0,
});

/** Font scale from damage: logarithmic, capped. */
export function magnitudeScale(value: number, m: NumbersRecipe["magnitude"]): number {
  const k = Math.min(1, Math.log1p(Math.max(0, value)) / Math.log1p(m.referenceValue));
  return m.minScale + k * (m.maxScale - m.minScale);
}

/** Lane x offsets alternate right, left, right... of centre. */
export function laneOffset(lane: number, spacing: number): number {
  return (lane % 2 === 0 ? 1 : -1) * Math.ceil(lane / 2) * spacing;
}

export class CombatNumbers {
  readonly pool: Floater[];
  readonly motion: MotionSystem;
  private readonly out: MotionOut = makeOut();
  private active = 0;
  private spawned = 0;

  constructor(readonly recipe: NumbersRecipe = DEFAULT_NUMBERS) {
    this.pool = Array.from({ length: recipe.budgets.maxGlobal }, blank);
    this.motion = new MotionSystem(recipe.budgets.maxGlobal);
  }

  get count(): number {
    return this.active;
  }

  /** A blow landed. `now` is ms on any clock the caller keeps for `update`. */
  hit(h: HitMessage, player: bigint | null, now: number): void {
    const r = this.recipe;
    const source = BigInt(h.source);
    const target = BigInt(h.target);
    const mine = player !== null && (source === player || target === player);
    if (h.outcome === "dodged") return this.add(target, "miss", 0, mine, now, "Miss");
    if (h.outcome === "blocked") return this.add(target, "block", h.amount, mine, now, h.amount > 0 ? String(Math.round(h.amount)) : "Block");
    if (h.amount <= 0) return;
    const heavy = h.max > 0 && h.amount / h.max >= r.heavyShare;
    this.add(target, heavy ? "heavy" : "damage", h.amount, mine, now, "");
  }

  private add(target: bigint, kind: NumberKind, value: number, mine: boolean, now: number, label: string): void {
    const r = this.recipe;
    let open: Floater | null = null;
    let onTarget = 0;
    let usedLanes = 0;
    for (const f of this.pool) {
      if (!f.live || f.target !== target) continue;
      onTarget++;
      usedLanes |= 1 << f.lane;
      if (f.kind === kind && kind !== "miss" && now - f.mergedAt <= r.accumulate.windowMs) open = f;
    }
    if (open) return this.merge(open, value, now);
    if (onTarget >= r.budgets.maxPerTarget) {
      // Fold into the target's newest floater rather than dropping the damage.
      let newest: Floater | null = null;
      for (const f of this.pool) if (f.live && f.target === target && (!newest || f.age < newest.age) && f.kind !== "miss") newest = f;
      if (newest) return this.merge(newest, value, now);
      return;
    }
    let slot: Floater | undefined = this.pool.find((f) => !f.live);
    if (!slot) {
      if (!mine) return;
      // The player's own hit evicts the oldest floater.
      slot = this.pool.reduce((a, b) => (b.age > a.age ? b : a));
      this.retire(slot);
    }
    let lane = 0;
    while (lane < r.lanes.count - 1 && usedLanes & (1 << lane)) lane++;
    slot.live = true;
    slot.target = target;
    slot.kind = kind;
    slot.value = value;
    slot.text = label;
    slot.lane = lane;
    slot.laneX = laneOffset(lane, r.lanes.spacing);
    slot.age = 0;
    slot.mergedAt = now;
    slot.mine = mine;
    slot.seed = ++this.spawned;
    slot.motion = this.motion.start(r.birth, { seed: slot.seed, priority: mine ? 2 : 1 });
    this.style(slot);
    this.active++;
  }

  private merge(f: Floater, value: number, now: number): void {
    f.value += value;
    f.mergedAt = now;
    f.age = Math.min(f.age, 120);
    this.style(f);
    this.motion.stop(f.motion);
    f.motion = this.motion.start({ steps: [{ p: "punch", ms: 120, amp: 0.3 }] }, { seed: f.seed, priority: f.mine ? 2 : 1 });
  }

  private style(f: Floater): void {
    const t = this.recipe.types[f.kind];
    f.color = t.color;
    if (f.kind !== "miss" && f.value > 0) f.text = t.prefix + Math.round(f.value);
    f.scale = magnitudeScale(f.value, this.recipe.magnitude) * t.scaleMul;
  }

  private retire(f: Floater): void {
    this.motion.stop(f.motion);
    f.live = false;
    f.motion = -1;
    this.active--;
  }

  /** Advance every floater `dt` seconds and fill its x, y, alpha, s, rot. */
  update(dt: number): void {
    const r = this.recipe;
    this.motion.tick(dt);
    for (const f of this.pool) {
      if (!f.live) continue;
      f.age += dt * 1000;
      if (f.age >= r.lifetimeMs) {
        this.retire(f);
        continue;
      }
      const t = f.age / 1000;
      const p = f.age / r.lifetimeMs;
      f.alpha = p < r.fadeStart ? 1 : 1 - (p - r.fadeStart) / (1 - r.fadeStart);
      f.x = f.laneX;
      f.y = -(r.rise * t - 0.5 * r.gravity * t * t);
      f.s = f.scale;
      f.rot = 0;
      if (this.motion.sample(f.motion, this.out)) {
        f.s *= this.out.scale;
        f.x += this.out.dx;
        f.y += this.out.dy;
      }
      if (f.kind === "heavy") {
        f.rot = (r.heavy.tiltDeg * Math.PI) / 180;
        const k = Math.max(0, 1 - p * 3) * r.heavy.shake;
        const n = Math.floor(f.age / 33);
        f.x += noise(f.seed, n) * k;
        f.y += noise(f.seed, n + 977) * k;
      }
    }
  }
}
