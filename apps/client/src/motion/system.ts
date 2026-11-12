/**
 * The Motion Grammar evaluator (roadmap CF1): recipes in, pooled stacks out.
 * A recipe is data, `{steps: [{p: "pop", overshoot: 1.35}, {p: "sineIdle"}]}`;
 * steps run in sequence (each after everything before it) unless `parallel` (start with the previous step) or
 * `at` (explicit start, ms). `staggerMs` delays a stack by index x staggerMs.
 * Slots are preallocated: no allocation per start or per sample. The slot
 * count is the budget, and `minPriority` is the quality tier that sheds
 * low-priority stacks first (distant things get a pop or nothing).
 */

import { PRIMITIVES, type MotionOut, type Primitive, type Step, resetOut } from "./primitives.js";

export interface Recipe {
  steps: Step[];
  /** Delay per `index` passed to start(), ms. */
  staggerMs?: number;
}

interface Compiled {
  prims: Primitive[];
  steps: Step[];
  start: number[];
  dur: number[];
  /** Total ms; Infinity when a step loops. */
  total: number;
  hitstops: number[];
  staggerMs: number;
}

const cache = new WeakMap<Recipe, Compiled>();

/** Resolve names and timings once per recipe; throws on an unknown primitive. */
export function compileRecipe(r: Recipe): Compiled {
  const hit = cache.get(r);
  if (hit) return hit;
  const c: Compiled = { prims: [], steps: r.steps, start: [], dur: [], total: 0, hitstops: [], staggerMs: r.staggerMs ?? 0 };
  let prevStart = 0;
  r.steps.forEach((s, i) => {
    const prim = PRIMITIVES[s.p];
    if (!prim) throw new Error(`motion: unknown primitive "${s.p}" (step ${i})`);
    const dur = s.ms ?? prim.ms;
    const start = s.at ?? (s.parallel ? prevStart : c.total);
    c.prims.push(prim);
    c.start.push(start);
    c.dur.push(dur);
    if (s.p === "hitstop") c.hitstops.push(i);
    prevStart = start;
    c.total = Math.max(c.total, dur === 0 ? Infinity : start + dur);
  });
  cache.set(r, c);
  return c;
}

export interface StartOptions {
  /** Index for `staggerMs` (cards dealt one by one). */
  index?: number;
  /** Seeds shake noise so two stacks do not jitter in step. */
  seed?: number;
  /** Shed first when the tier rises; default 1. */
  priority?: number;
}

const GEN_STRIDE = 65536;

export class MotionSystem {
  /** 1 normally, the `hitstop` scale during a freeze; scale your own clocks by it. */
  timeScale = 1;
  /** Quality tier: starts with a lower priority are refused. */
  minPriority = 0;
  /** Starts refused (full pool or below the tier), for the perf overlay. */
  shed = 0;
  private active = 0;
  private stopLeft = 0;
  private readonly rec: (Compiled | null)[];
  private readonly elapsed: Float64Array;
  private readonly delay: Float64Array;
  private readonly seed: Float64Array;
  private readonly gen: Uint16Array;
  private readonly free: number[] = [];

  constructor(readonly capacity = 512) {
    if (capacity >= GEN_STRIDE) throw new Error("motion: capacity must be under 65536");
    this.rec = new Array<Compiled | null>(capacity).fill(null);
    this.elapsed = new Float64Array(capacity);
    this.delay = new Float64Array(capacity);
    this.seed = new Float64Array(capacity);
    this.gen = new Uint16Array(capacity);
    for (let i = capacity - 1; i >= 0; i--) this.free.push(i);
  }

  get activeCount(): number {
    return this.active;
  }

  /** Begin a stack; returns a handle, or -1 when shed. */
  start(recipe: Recipe, o: StartOptions = {}): number {
    const c = compileRecipe(recipe);
    const slot = (o.priority ?? 1) < this.minPriority ? undefined : this.free.pop();
    if (slot === undefined) {
      this.shed++;
      return -1;
    }
    this.rec[slot] = c;
    this.elapsed[slot] = 0;
    this.delay[slot] = (o.index ?? 0) * c.staggerMs;
    this.seed[slot] = o.seed ?? slot;
    this.active++;
    return this.gen[slot]! * GEN_STRIDE + slot;
  }

  private slotOf(h: number): number {
    if (h < 0) return -1;
    const slot = h % GEN_STRIDE;
    return this.rec[slot] && this.gen[slot] === Math.floor(h / GEN_STRIDE) ? slot : -1;
  }

  stop(h: number): void {
    const slot = this.slotOf(h);
    if (slot >= 0) this.release(slot);
  }

  private release(slot: number): void {
    this.rec[slot] = null;
    this.gen[slot] = (this.gen[slot]! + 1) & 0xffff;
    this.free.push(slot);
    this.active--;
  }

  /** Freeze the world's clocks for `ms` (the longest wins). */
  hitstop(ms: number, scale = 0): void {
    if (ms > this.stopLeft) {
      this.stopLeft = ms;
      this.timeScale = scale;
    }
  }

  /** Advance every stack by `dt` seconds of real time and retire the finished. */
  tick(dt: number): void {
    if (this.stopLeft > 0) {
      this.stopLeft -= dt * 1000;
      if (this.stopLeft <= 0) {
        this.stopLeft = 0;
        this.timeScale = 1;
      }
    }
    const dms = dt * 1000 * this.timeScale;
    if (dms <= 0) return;
    for (let i = 0; i < this.capacity; i++) {
      const c = this.rec[i];
      if (!c) continue;
      const prev = this.elapsed[i]! - this.delay[i]!;
      const cur = prev + dms;
      this.elapsed[i] = this.elapsed[i]! + dms;
      for (const k of c.hitstops) {
        const at = c.start[k]!;
        if (prev <= at && at < cur) {
          const s = c.steps[k]!;
          this.hitstop(c.dur[k]!, typeof s.scale === "number" ? s.scale : 0);
        }
      }
      if (cur >= c.total) this.release(i);
    }
  }

  /** Write the stack's current pose into `out`; false once finished (rest pose). */
  sample(h: number, out: MotionOut): boolean {
    const i = this.slotOf(h);
    resetOut(out);
    if (i < 0) return false;
    const c = this.rec[i]!;
    const now = this.elapsed[i]! - this.delay[i]!;
    for (let k = 0; k < c.prims.length; k++) {
      const prim = c.prims[k]!;
      const dur = c.dur[k]!;
      const t = now - c.start[k]!;
      if (t < 0) {
        if (prim.hold) prim.apply(out, 0, 0, c.steps[k]!, this.seed[i]!);
        continue;
      }
      const tc = dur === 0 ? t : Math.min(t, dur);
      prim.apply(out, tc, dur === 0 ? 0 : tc / dur, c.steps[k]!, this.seed[i]!);
    }
    return true;
  }
}
