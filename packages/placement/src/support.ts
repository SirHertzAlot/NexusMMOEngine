/**
 * Structural support for buildings (DE3): which part holds up which, and what is left unsupported when parts are
 * removed. Pure, over `SupportPart` boxes in metres (a part's `pos` is its centre). Lives here, not in the synthesis
 * package, so the server can use it without pulling in the model tooling. No rules or entities: DE4 decides what falls and when; this says what
 * would, and in what order.
 *
 * The model, kept simple enough to follow:
 *   - A part is *grounded* when its underside is at the building's ground level. Grounded parts never fall here
 *     (breaking one is a break, not a collapse).
 *   - A part *rests on* another when that one lies below it with its top at the part's underside and their
 *     footprints overlap. Its supporters are every part it rests on.
 *   - A door, window or other fixture is *attached*: it hangs from whatever touches it, and holds while any of
 *     those stands. So does a part that rests on nothing yet touches its neighbours (a module whose pack leaves a
 *     gap beneath it): it is *bonded* to them the same way.
 *   - A resting part stays up while its centre lies inside the support polygon (the convex hull of its contacts
 *     with the supporters still standing), as a real load does. Take two of four walls away and the roof still
 *     spans the rest; leave it on one wall and it falls.
 */

/** A part of a structure, as the support graph sees it: a box, in metres, turned by yaw about the vertical axis. */
export interface SupportPart {
  /** Its centre. */
  pos: readonly [number, number, number];
  /** Its extent along its own axes before yaw: width (x), height (y), depth (z). */
  size: readonly [number, number, number];
  yawDeg: number;
  /** What kind of part it is ("wall", "door"...); with `id`, what the fixtures pattern is matched against. */
  category: string;
  id?: string;
}

interface Aabb {
  min: [number, number, number];
  max: [number, number, number];
}

/** A part's world box: its size turned by its yaw, about its centre. */
function boxOf(p: SupportPart): Aabb {
  const [w, h, d] = p.size;
  const yaw = (p.yawDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const hx = (Math.abs(w) * c + Math.abs(d) * s) / 2;
  const hz = (Math.abs(w) * s + Math.abs(d) * c) / 2;
  const hy = Math.abs(h) / 2;
  const [x, y, z] = p.pos;
  return { min: [x - hx, y - hy, z - hz], max: [x + hx, y + hy, z + hz] };
}

/** Whether two boxes overlap or lie within `gap` of each other on every axis. */
function touches(a: Aabb, b: Aabb, gap: number): boolean {
  for (let k = 0; k < 3; k++) if (a.min[k]! > b.max[k]! + gap || b.min[k]! > a.max[k]! + gap) return false;
  return true;
}

export interface SupportOptions {
  /** The ground's height; default: the lowest underside among the parts. */
  groundY?: number;
  /** How far a part's underside may be from the top of what holds it, metres (default 0.25). */
  verticalTol?: number;
  /** How far above the ground a part's underside may be and still count as grounded (default 0.1). */
  groundTol?: number;
  /** Footprints must overlap by at least this much on both axes, metres (default 0.05). */
  minOverlapM?: number;
  /** Slack on the support polygon, metres: a centre this far outside it still holds (default 0.1). */
  stabilityTol?: number;
  /** Fixtures: part ids or categories matching this hang from what they touch (default doors, windows and the like). */
  attached?: RegExp;
}

/** What hangs rather than rests. */
/** How close parts must be to count as touching, metres (the same 0.15 the detached-part prune uses). */
const BOND_GAP_M = 0.15;

export const ATTACHED_PARTS = /door|window|shutter|sign|lamp|torch|banner|chimney/i;

export interface SupportLink {
  /** The index of the supporting part. */
  to: number;
  kind: "rests" | "attached" | "bonded";
  /** The overlap of the two footprints on the ground plane: [minX, minZ, maxX, maxZ] (rests only). */
  contact?: [number, number, number, number];
}

export interface SupportGraph {
  count: number;
  /** For each part, what holds it up. Empty for grounded parts. */
  supporters: SupportLink[][];
  /** For each part, the parts that depend on it (the reverse of `supporters`). */
  dependents: number[][];
  grounded: boolean[];
  /** Whether each part stands with nothing removed: grounded, or held by something that stands. A part that does not floats in the data (nothing holds it). */
  stands: boolean[];
  /** Each part's centre on the ground plane, for the stability test. */
  centre: Array<[number, number]>;
  stabilityTol: number;
}

const isAttached = (p: SupportPart, re: RegExp): boolean => re.test(p.category) || re.test(p.id ?? "");

/** The ground-plane overlap of two boxes, or null when they overlap by less than `min` on either axis. */
function footprintOverlap(a: Aabb, b: Aabb, min: number): [number, number, number, number] | null {
  const x0 = Math.max(a.min[0], b.min[0]);
  const x1 = Math.min(a.max[0], b.max[0]);
  const z0 = Math.max(a.min[2], b.min[2]);
  const z1 = Math.min(a.max[2], b.max[2]);
  return x1 - x0 >= min && z1 - z0 >= min ? [x0, z0, x1, z1] : null;
}

/** Work out what holds up what. O(n^2) in the parts of one building (a few hundred at most); one building at a time. */
export function buildSupportGraph(parts: readonly SupportPart[], o: SupportOptions = {}): SupportGraph {
  const vTol = o.verticalTol ?? 0.25;
  const groundTol = o.groundTol ?? 0.1;
  const minOverlap = o.minOverlapM ?? 0.05;
  const attachedRe = o.attached ?? ATTACHED_PARTS;
  const boxes = parts.map(boxOf);
  const groundY = o.groundY ?? boxes.reduce((m, b) => Math.min(m, b.min[1]), Infinity);
  const n = parts.length;
  const supporters: SupportLink[][] = parts.map(() => []);
  const dependents: number[][] = parts.map(() => []);
  const grounded = boxes.map((b) => b.min[1] <= groundY + groundTol);
  const fixture = parts.map((p) => isAttached(p, attachedRe));
  for (let i = 0; i < n; i++) {
    if (grounded[i]) continue;
    const a = boxes[i]!;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = boxes[j]!;
      if (fixture[i]) {
        // A fixture hangs from any structural part it touches (never from another fixture).
        if (!fixture[j] && touches(a, b, BOND_GAP_M)) supporters[i]!.push({ to: j, kind: "attached" });
      } else if (!fixture[j] && Math.abs(b.max[1] - a.min[1]) <= vTol && b.min[1] < a.min[1]) {
        // Rests on what lies below it, top to underside.
        const contact = footprintOverlap(a, b, minOverlap);
        if (contact) supporters[i]!.push({ to: j, kind: "rests", contact });
      }
    }
    // Resting on nothing: bonded to whatever it touches, so a gap under a module does not leave it hanging in the model.
    if (supporters[i]!.length === 0 && !fixture[i]) {
      for (let j = 0; j < n; j++) if (j !== i && !fixture[j] && touches(a, boxes[j]!, BOND_GAP_M)) supporters[i]!.push({ to: j, kind: "bonded" });
    }
  }
  for (let i = 0; i < n; i++) for (const s of supporters[i]!) dependents[s.to]!.push(i);
  const g: SupportGraph = {
    count: n,
    supporters,
    dependents,
    grounded,
    stands: [],
    centre: boxes.map((b) => [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2]),
    stabilityTol: o.stabilityTol ?? 0.1,
  };
  g.stands = standing(g, new Set());
  return g;
}

/** The parts that stand with `gone` removed: the least fixed point from the grounded parts outward, so a ring of parts holding only each other does not stand. */
function standing(g: SupportGraph, gone: ReadonlySet<number>): boolean[] {
  const up = g.grounded.map((v, i) => v && !gone.has(i));
  const queue: number[] = [];
  up.forEach((v, i) => v && queue.push(i));
  for (let q = 0; q < queue.length; q++) {
    for (const d of g.dependents[queue[q]!]!) {
      if (up[d] || gone.has(d) || g.grounded[d]) continue;
      if (holds(g, d, (j) => up[j]!)) {
        up[d] = true;
        queue.push(d);
      }
    }
  }
  return up;
}

type Pt = [number, number];

const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** The convex hull of points, counter-clockwise (Andrew's monotone chain). */
function hull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Whether `c` lies inside the convex polygon `poly` (counter-clockwise), allowing `tol` metres outside it. */
function insideHull(poly: Pt[], c: Pt, tol: number): boolean {
  if (poly.length < 3) return false;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k]!;
    const b = poly[(k + 1) % poly.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    if (cross(a, b, c) / len < -tol) return false;
  }
  return true;
}

export interface Fallen {
  index: number;
  /** How far the loss has spread when this part goes: 1 for what the removal itself unsupports, 2 for what those drag down, and so on. */
  wave: number;
}

/**
 * What falls when the `removed` parts are gone: every part that stood and no longer does, in the order the loss
 * spreads (wave by wave, then by index). Removed parts, and parts that never stood, are not in the result.
 */
export function collapseFrom(g: SupportGraph, removed: Iterable<number>): Fallen[] {
  const gone = new Set<number>(removed);
  const up = standing(g, gone);
  const falls = (i: number): boolean => g.stands[i]! && !up[i]! && !gone.has(i);
  const wave = new Map<number, number>();
  let frontier = [...gone];
  for (let w = 1; frontier.length > 0; w++) {
    const next: number[] = [];
    for (const r of frontier) {
      for (const d of g.dependents[r]!) {
        if (!wave.has(d) && falls(d)) {
          wave.set(d, w);
          next.push(d);
        }
      }
    }
    frontier = next;
  }
  const out: Fallen[] = [];
  let last = 0;
  for (const w of wave.values()) last = Math.max(last, w);
  for (let i = 0; i < g.count; i++) if (falls(i)) out.push({ index: i, wave: wave.get(i) ?? last + 1 });
  return out.sort((a, b) => a.wave - b.wave || a.index - b.index);
}

/** Whether part `i` is held up, counting only the supporters `live` says stand. */
function holds(g: SupportGraph, i: number, live: (j: number) => boolean): boolean {
  const ups = g.supporters[i]!.filter((s) => live(s.to));
  if (ups.length === 0) return false;
  // A fixture, or a bonded part, holds on any one thing it hangs from.
  if (ups.some((s) => s.kind !== "rests")) return true;
  const points: Pt[] = [];
  for (const s of ups) {
    const [x0, z0, x1, z1] = s.contact!;
    points.push([x0, z0], [x1, z0], [x1, z1], [x0, z1]);
  }
  return insideHull(hull(points), g.centre[i]!, g.stabilityTol);
}
