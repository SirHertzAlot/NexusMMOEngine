/**
 * Motion Grammar primitives (roadmap CF1): named feel moves, each a pure
 * function of time and parameters that writes into a shared output. A recipe
 * (data) names primitives; nothing is re-coded per feature. Presentation
 * only: never simulated server-side, never networked.
 */

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Smooth 0..1 ease (3x^2 - 2x^3) of a progress; clamps first. */
export const smooth01 = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** What a stack writes. Reused every frame: no allocation. */
export interface MotionOut {
  /** Uniform scale, multiplied across steps. */
  scale: number;
  /** Per-axis scale, multiplied across steps. */
  sx: number;
  sy: number;
  /** Offsets and rotation (radians), added across steps. */
  dx: number;
  dy: number;
  rot: number;
  /** Opacity, multiplied. */
  alpha: number;
  /** Colour overlay strength 0..1, the strongest step wins. */
  flash: number;
  /** Card flip: 0 front, 1 back (swap the face at 0.5). */
  face: number;
  /** Transition progress 0..1. */
  wipe: number;
}

export function makeOut(): MotionOut {
  return { scale: 1, sx: 1, sy: 1, dx: 0, dy: 0, rot: 0, alpha: 1, flash: 0, face: 0, wipe: 0 };
}

export function resetOut(o: MotionOut): MotionOut {
  o.scale = o.sx = o.sy = o.alpha = 1;
  o.dx = o.dy = o.rot = o.flash = o.face = o.wipe = 0;
  return o;
}

/** One recipe step: a primitive name plus its parameter overrides. */
export type Step = { p: string; ms?: number; parallel?: boolean; at?: number } & Record<string, number | string | boolean | undefined>;

const num = (s: Step, k: string, d: number): number => {
  const v = s[k];
  return typeof v === "number" ? v : d;
};

/** Deterministic noise in -1..1 (shake needs no RNG state). */
export function noise(seed: number, n: number): number {
  const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

export interface Primitive {
  /** Default duration, ms; 0 loops until stopped. */
  ms: number;
  /** Before it starts, show its first frame (pop waits at `from`, flip at the front). */
  hold?: boolean;
  /** t: ms into the step (clamped to the duration); p: t/duration (0 for loops). */
  apply(out: MotionOut, t: number, p: number, s: Step, seed: number): void;
}

const axisAdd = (out: MotionOut, axis: unknown, v: number): void => {
  if (axis === "x") out.dx += v;
  else if (axis === "rot") out.rot += v;
  else if (axis === "scale") out.scale *= 1 + v;
  else out.dy += v;
};

export const PRIMITIVES: Readonly<Record<string, Primitive>> = {
  /** Scale overshoot on birth: from -> overshoot (at 60 %) -> 1. */
  pop: {
    ms: 120,
    hold: true,
    apply(out, _t, p, s) {
      const from = num(s, "from", 0);
      const over = num(s, "overshoot", 1.35);
      out.scale *= p < 0.6 ? lerp(from, over, smooth01(p / 0.6)) : lerp(over, 1, smooth01((p - 0.6) / 0.4));
    },
  },
  /** Landing squash (amount > 0) or fall stretch (amount < 0), springing back. */
  squashStretch: {
    ms: 180,
    apply(out, _t, p, s) {
      const e = (1 - p) * (1 - p) * Math.cos(p * Math.PI * 2) * num(s, "amount", 0.3);
      out.sx *= 1 + e;
      out.sy *= 1 - e;
    },
  },
  /** Counter-move before the action (`amount` px along `axis`, default y). */
  anticipation: {
    ms: 120,
    apply(out, _t, p, s) {
      axisAdd(out, s.axis, num(s, "amount", 6) * Math.sin(p * Math.PI));
    },
  },
  /** Endless sine drift: amp, freq (Hz), phase (radians), axis. */
  sineIdle: {
    ms: 0,
    apply(out, t, _p, s) {
      axisAdd(out, s.axis, num(s, "amp", 2) * Math.sin(Math.PI * 2 * num(s, "freq", 0.8) * (t / 1000) + num(s, "phase", 0)));
    },
  },
  /** Scale burst decaying to 1, with an optional shake. */
  punch: {
    ms: 140,
    apply(out, t, p, s, seed) {
      const k = (1 - p) * (1 - p);
      out.scale *= 1 + num(s, "amp", 0.25) * k;
      const sh = num(s, "shake", 0) * k;
      if (sh > 0) {
        const n = Math.floor((t / 1000) * 30);
        out.dx += noise(seed, n) * sh;
        out.dy += noise(seed, n + 977) * sh;
      }
    },
  },
  /** Colour overlay that decays. */
  flash: {
    ms: 120,
    apply(out, _t, p, s) {
      out.flash = Math.max(out.flash, num(s, "amount", 1) * (1 - p));
    },
  },
  /** Decaying jitter: amp (px), freq (Hz), decay (exponent). */
  shake: {
    ms: 200,
    apply(out, t, p, s, seed) {
      const k = Math.pow(1 - p, num(s, "decay", 1)) * num(s, "amp", 4);
      const n = Math.floor((t / 1000) * num(s, "freq", 30));
      out.dx += noise(seed, n) * k;
      out.dy += noise(seed, n + 977) * k;
    },
  },
  /** Global timescale dip (the system applies it): ms, scale (default 0). */
  hitstop: { ms: 70, apply() {} },
  /** Flip by squeezing X to zero and swapping the face at the midpoint. */
  flip: {
    ms: 300,
    hold: true,
    apply(out, _t, p) {
      out.sx *= Math.max(0.001, Math.abs(Math.cos(p * Math.PI)));
      out.face = p >= 0.5 ? 1 : 0;
    },
  },
  /** Page transition progress 0..1 (the view draws the wipe). */
  wipe: {
    ms: 400,
    apply(out, _t, p) {
      out.wipe = smooth01(p);
    },
  },
};

/** Frame-rate independent chase: move `cur` toward `target` at `rate` per second. */
export function lerpFollow(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

/** Scalar spring-damper state (F = -k x - c v). Stateful, so not a recipe step. */
export interface SpringState {
  x: number;
  v: number;
}

/** Advance a spring toward `target` (semi-implicit Euler, substepped for stability). */
export function springStep(s: SpringState, target: number, k: number, c: number, dt: number): void {
  const n = Math.max(1, Math.ceil(dt * 120));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (-k * (s.x - target) - c * s.v) * h;
    s.x += s.v * h;
  }
}
