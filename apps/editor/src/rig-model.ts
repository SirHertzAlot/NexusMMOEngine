/**
 * The Rig view's rules (browser-safe, pure, no three.js): the editable chains
 * of a bone tree, where each leaf bone ends, the heat / region colours of
 * the skin weights, and the foot trace that shows a gait's foot paths and
 * stance slide. Works on any bone list, the quadruped auto-rig's or the
 * bones a skinned model already has: the scene builds `RigBone[]` from its
 * skeleton at rest and everything here follows from that.
 */
import type { Triple } from "./rig-doc.js";

export interface RigBone {
  name: string;
  /** Index of the parent bone, -1 for a root. */
  parent: number;
  /** Rest pivot, in the rig's frame (+Z forward, +Y up). */
  rest: Triple;
}
/** aim: one bone turned at a target. limb2: hip-knee-foot, analytic. fabrik: three or more bones. */
export type ChainKind = "aim" | "limb2" | "fabrik";
export interface Chain {
  /** The tip bone's name: how overrides refer to the chain. */
  id: string;
  /** Bone indices, root first. */
  bones: number[];
  kind: ChainKind;
}

/** Longest run of single-child bones taken as one chain (a ponytail, a tail, a spine). */
export const MAX_CHAIN = 8;

/** One chain per leaf bone: the leaf plus the single-child bones above it. */
export function discoverChains(bones: readonly RigBone[]): Chain[] {
  const children = new Int32Array(bones.length);
  for (const b of bones) if (b.parent >= 0) children[b.parent]++;
  const chains: Chain[] = [];
  bones.forEach((leaf, i) => {
    if (children[i] !== 0) return;
    const run = [i];
    let p = leaf.parent;
    while (p >= 0 && children[p] === 1 && run.length < MAX_CHAIN) {
      run.unshift(p);
      p = bones[p].parent;
    }
    chains.push({ id: leaf.name, bones: run, kind: run.length === 1 ? "aim" : run.length === 2 ? "limb2" : "fabrik" });
  });
  return chains;
}

/**
 * Where each bone ends. A bone with children ends at its first child; a leaf
 * ends at the far end of the vertices it owns (the centroid of those within
 * 15% of the farthest), or a hand's breadth below its pivot with none.
 */
export function tipsFromSkin(bones: readonly RigBone[], positions: ArrayLike<number>, skinIndex: ArrayLike<number>, skinWeight: ArrayLike<number>): Triple[] {
  const n = Math.floor(positions.length / 3);
  const tips: Triple[] = bones.map((b) => [b.rest[0], b.rest[1] - 0.05, b.rest[2]]);
  const hasChild = new Uint8Array(bones.length);
  for (const b of bones) {
    if (b.parent >= 0 && !hasChild[b.parent]) {
      hasChild[b.parent] = 1;
      tips[b.parent] = [b.rest[0], b.rest[1], b.rest[2]];
    }
  }
  const far = new Float64Array(bones.length);
  const owns = (v: number, bone: number): boolean => {
    for (let k = 0; k < 4; k++) if (skinIndex[v * 4 + k] === bone && skinWeight[v * 4 + k] > 0.5) return true;
    return false;
  };
  bones.forEach((b, bi) => {
    if (hasChild[bi]) return;
    for (let v = 0; v < n; v++) {
      if (owns(v, bi)) far[bi] = Math.max(far[bi], Math.hypot(positions[v * 3] - b.rest[0], positions[v * 3 + 1] - b.rest[1], positions[v * 3 + 2] - b.rest[2]));
    }
    if (far[bi] <= 0) return;
    let sx = 0, sy = 0, sz = 0, c = 0;
    for (let v = 0; v < n; v++) {
      if (owns(v, bi) && Math.hypot(positions[v * 3] - b.rest[0], positions[v * 3 + 1] - b.rest[1], positions[v * 3 + 2] - b.rest[2]) >= far[bi] * 0.85) {
        sx += positions[v * 3];
        sy += positions[v * 3 + 1];
        sz += positions[v * 3 + 2];
        c++;
      }
    }
    tips[bi] = [sx / c, sy / c, sz / c];
  });
  return tips;
}

/** A chain's joints then its tip, as xyz triples (what FABRIK and the two-bone solver start from). */
export function chainPoints(bones: readonly RigBone[], chain: Chain, tips: readonly Triple[]): Float64Array {
  const out = new Float64Array((chain.bones.length + 1) * 3);
  chain.bones.forEach((b, k) => out.set(bones[b].rest, k * 3));
  out.set(tips[chain.bones[chain.bones.length - 1]], chain.bones.length * 3);
  return out;
}

/** The direction a limb's middle joint points by default: a front leg's carpus forward, a hind leg's hock back. */
export function poleFor(tipName: string, rest: Triple): Triple {
  const hind = /H[LR]$|hind|rear/i.test(tipName) || (!/F[LR]$/.test(tipName) && rest[2] < -0.2);
  return hind ? [0, 0, -1] : [0, 0, 1];
}

// ---------------------------------------------------------------- colours

/** A stable, well-spread colour per bone index (golden-angle hue steps). */
export function boneColor(i: number): Triple {
  const h = ((i * 0.61803398875) % 1) * 6;
  const s = 0.6, l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** Per vertex rgb: the bone colours blended by the skin weights. `out` has 3 floats per vertex. */
export function regionColors(skinIndex: ArrayLike<number>, skinWeight: ArrayLike<number>, out: Float32Array): void {
  const n = out.length / 3;
  for (let v = 0; v < n; v++) {
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[v * 4 + k];
      if (w <= 0) continue;
      const c = boneColor(skinIndex[v * 4 + k]);
      r += c[0] * w;
      g += c[1] * w;
      b += c[2] * w;
    }
    out[v * 3] = r;
    out[v * 3 + 1] = g;
    out[v * 3 + 2] = b;
  }
}

/** A bone's weight at a vertex (0 when it has none there). */
const weightOf = (skinIndex: ArrayLike<number>, skinWeight: ArrayLike<number>, v: number, bone: number): number => {
  let w = 0;
  for (let k = 0; k < 4; k++) if (skinIndex[v * 4 + k] === bone) w += skinWeight[v * 4 + k];
  return w;
};

/** Blue (no weight) through green to red (full weight) for one bone. */
export function heatColors(skinIndex: ArrayLike<number>, skinWeight: ArrayLike<number>, bone: number, out: Float32Array): void {
  const n = out.length / 3;
  for (let v = 0; v < n; v++) {
    const w = Math.min(1, Math.max(0, weightOf(skinIndex, skinWeight, v, bone)));
    out[v * 3] = Math.min(1, Math.max(0, 2 * w - 0.5));
    out[v * 3 + 1] = Math.max(0, 1 - Math.abs(2 * w - 1) * 1.6);
    out[v * 3 + 2] = Math.min(1, Math.max(0, 1 - 2 * w) + 0.15);
  }
}

/** One bone in its colour (fading with its weight), everything else grey. */
export function isolateColors(skinIndex: ArrayLike<number>, skinWeight: ArrayLike<number>, bone: number, out: Float32Array): void {
  const n = out.length / 3;
  const c = boneColor(bone);
  for (let v = 0; v < n; v++) {
    const w = Math.min(1, weightOf(skinIndex, skinWeight, v, bone));
    const grey = 0.22;
    out[v * 3] = grey + (c[0] - grey) * w;
    out[v * 3 + 1] = grey + (c[1] - grey) * w;
    out[v * 3 + 2] = grey + (c[2] - grey) * w;
  }
}

/** The bone with the largest weight at vertex v. */
export function partOfVertex(skinIndex: ArrayLike<number>, skinWeight: ArrayLike<number>, v: number): number {
  let best = skinIndex[v * 4], bw = -1;
  for (let k = 0; k < 4; k++) {
    if (skinWeight[v * 4 + k] > bw) {
      bw = skinWeight[v * 4 + k];
      best = skinIndex[v * 4 + k];
    }
  }
  return best;
}

// ---------------------------------------------------------------- foot trace

export interface SlideStats {
  /** How many segments were in stance. */
  samples: number;
  /** Metres per second the foot moved relative to the ground it should be fixed to. */
  max: number;
  mean: number;
}

/**
 * The last `capacity` steps of one foot, stored as line segments (so a
 * LineSegments can draw them straight from `segments`, with no seam where the
 * ring wraps) with their times. Nothing is allocated after construction.
 *
 * Seen from the animal on a treadmill, ground speed `v` runs backwards (-z):
 * a foot on the ground must move at -v, and `stanceSlide` is how far from
 * that the stance steps are.
 */
export class FootTrace {
  readonly segments: Float32Array;
  private readonly times: Float64Array;
  private head = 0;
  count = 0;
  private hasPrev = false;
  private px = 0;
  private py = 0;
  private pz = 0;
  private pt = 0;

  constructor(readonly capacity: number) {
    this.segments = new Float32Array(capacity * 6);
    this.times = new Float64Array(capacity * 2);
  }

  push(x: number, y: number, z: number, t: number): void {
    if (!this.hasPrev) {
      this.px = x;
      this.py = y;
      this.pz = z;
      this.pt = t;
      this.hasPrev = true;
    }
    const s = this.head * 6;
    this.segments[s] = this.px;
    this.segments[s + 1] = this.py;
    this.segments[s + 2] = this.pz;
    this.segments[s + 3] = x;
    this.segments[s + 4] = y;
    this.segments[s + 5] = z;
    this.times[this.head * 2] = this.pt;
    this.times[this.head * 2 + 1] = t;
    this.px = x;
    this.py = y;
    this.pz = z;
    this.pt = t;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  clear(): void {
    this.segments.fill(0);
    this.head = 0;
    this.count = 0;
    this.hasPrev = false;
  }

  /** Slide of the steps whose both ends are at or below `stanceY` (the foot on the ground), against a ground moving back at `speed`. */
  stanceSlide(speed: number, stanceY: number): SlideStats {
    let samples = 0, max = 0, sum = 0;
    for (let k = 0; k < this.count; k++) {
      const dt = this.times[k * 2 + 1] - this.times[k * 2];
      if (dt <= 0) continue;
      if (this.segments[k * 6 + 1] > stanceY || this.segments[k * 6 + 4] > stanceY) continue;
      const slide = Math.abs((this.segments[k * 6 + 5] - this.segments[k * 6 + 2]) / dt + speed);
      samples++;
      sum += slide;
      if (slide > max) max = slide;
    }
    return { samples, max, mean: samples ? sum / samples : 0 };
  }
}
