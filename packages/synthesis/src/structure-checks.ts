/**
 * Structure checks for synthesized buildings: what a settlement's synthesis pass runs after growth, before export.
 *
 *   - `isOpenKind` / `synthesisRoute`: open ground (a garden, a churchyard, a park, a field) is never grown through an
 *     enclosed-building template. Routing them there produced hundreds of house parts for a garden.
 *   - `detachedParts` / `pruneDetached`: a part that touches no other part (or a group that never reaches the ground)
 *     is not a building: it floats or stands alone. Pruned before the scene is written.
 *   - `envelopeReport`: an enclosed building closes: wall parts along all four sides of its footprint, and a roof.
 *
 * Pure, over `SynthesizedPlacement`s, in metres. A placement's `transform.pos` is its centre.
 */

import type { SynthesizedPlacement } from "./types.js";
import { yawDegrees } from "./to-scene.js";

/** Settlement kinds that are open ground, not buildings. */
export const OPEN_KINDS: ReadonlySet<string> = new Set(["garden", "churchyard", "park", "empty_lot", "farm_field", "ranch_pen", "town_square", "paved_road", "camp_site"]);

/** A kind as written in a scene or a template key (`building:garden`, `structure:garden`) without its prefix. */
export function bareKind(kind: string): string {
  const i = kind.lastIndexOf(":");
  return i >= 0 ? kind.slice(i + 1) : kind;
}

export const isOpenKind = (kind: string): boolean => OPEN_KINDS.has(bareKind(kind));

/** Which synthesis a kind goes through: enclosed-building templates, or open-ground dressing (never walls and a roof). */
export const synthesisRoute = (kind: string): "enclosed" | "open" => (isOpenKind(kind) ? "open" : "enclosed");

export interface Aabb {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Where a part's middle lies from its position (its pivot), in the part's own axes before yaw: the centre of its
 * model bounds times its scale. A part with no bounds is taken as centred on its position.
 */
export function pivotCentre(p: SynthesizedPlacement): [number, number, number] {
  const b = p.pivotBounds;
  if (!b) return [0, 0, 0];
  const [sx, sy, sz] = p.transform.scale;
  return [((b.min[0] + b.max[0]) / 2) * sx, ((b.min[1] + b.max[1]) / 2) * sy, ((b.min[2] + b.max[2]) / 2) * sz];
}

/** A point `c` in a part's own axes, in the parent's, for a part turned `yawDeg` about the vertical axis (the scene's convention). */
export function turnByYaw(c: readonly [number, number, number], yawDeg: number): [number, number, number] {
  const y = (yawDeg * Math.PI) / 180;
  const cos = Math.cos(y);
  const sin = Math.sin(y);
  return [c[0] * cos + c[2] * sin, c[1], -c[0] * sin + c[2] * cos];
}

/** A placement's world box: its size turned by its yaw about the vertical axis, about its middle (its position is its pivot, not its middle). */
export function placementBox(p: SynthesizedPlacement): Aabb {
  const [w, h, d] = p.size;
  const yawDeg = yawDegrees(p.transform.rot);
  const yaw = (yawDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const hx = (Math.abs(w) * c + Math.abs(d) * s) / 2;
  const hz = (Math.abs(w) * s + Math.abs(d) * c) / 2;
  const hy = Math.abs(h) / 2;
  const off = turnByYaw(pivotCentre(p), yawDeg);
  const x = p.transform.pos[0] + off[0];
  const y = p.transform.pos[1] + off[1];
  const z = p.transform.pos[2] + off[2];
  return { min: [x - hx, y - hy, z - hz], max: [x + hx, y + hy, z + hz] };
}

/** Whether two boxes overlap or lie within `gap` of each other on every axis. */
export function touches(a: Aabb, b: Aabb, gap: number): boolean {
  for (let k = 0; k < 3; k++) if (a.min[k]! > b.max[k]! + gap || b.min[k]! > a.max[k]! + gap) return false;
  return true;
}

export interface Component {
  /** Indices into the placements. */
  parts: number[];
  box: Aabb;
  /** The lowest point of any part. */
  bottom: number;
}

/** The groups of parts that touch one another (within `gap`), found through a grid so it stays near-linear. */
export function connectedComponents(placements: readonly SynthesizedPlacement[], gap = 0.15): Component[] {
  const boxes = placements.map(placementBox);
  const parent = placements.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const CELL = 4;
  const grid = new Map<string, number[]>();
  const cellsOf = (b: Aabb): string[] => {
    const out: string[] = [];
    for (let x = Math.floor((b.min[0] - gap) / CELL); x <= Math.floor((b.max[0] + gap) / CELL); x++) for (let z = Math.floor((b.min[2] - gap) / CELL); z <= Math.floor((b.max[2] + gap) / CELL); z++) out.push(`${x},${z}`);
    return out;
  };
  boxes.forEach((b, i) => {
    for (const key of cellsOf(b)) {
      const bucket = grid.get(key);
      if (bucket) {
        for (const j of bucket) if (find(i) !== find(j) && touches(b, boxes[j]!, gap)) parent[find(i)] = find(j);
        bucket.push(i);
      } else grid.set(key, [i]);
    }
  });
  const groups = new Map<number, number[]>();
  boxes.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  });
  return [...groups.values()].map((parts) => {
    const box: Aabb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const i of parts) for (let k = 0; k < 3; k++) {
      box.min[k] = Math.min(box.min[k]!, boxes[i]!.min[k]!);
      box.max[k] = Math.max(box.max[k]!, boxes[i]!.max[k]!);
    }
    return { parts, box, bottom: box.min[1] };
  });
}

export interface PruneOptions {
  /** Parts closer than this count as touching, metres (default 0.15). */
  gap?: number;
  /** A group smaller than this is not a building (default 3 parts). */
  minParts?: number;
  /** The ground's height; a group whose lowest point is not within `gap` of it floats (default: the lowest part of the biggest group). */
  groundY?: number;
}

export interface PruneResult {
  kept: SynthesizedPlacement[];
  /** The indices removed, and why. */
  removed: Array<{ index: number; reason: "isolated" | "small-group" | "floating" }>;
}

/** The parts that are not part of a building: alone, in a group too small to be one, or in a group that never reaches the ground. */
export function pruneDetached(placements: readonly SynthesizedPlacement[], o: PruneOptions = {}): PruneResult {
  const gap = o.gap ?? 0.15;
  const minParts = o.minParts ?? 3;
  const groups = connectedComponents(placements, gap);
  const main = groups.reduce<Component | null>((a, g) => (!a || g.parts.length > a.parts.length ? g : a), null);
  const ground = o.groundY ?? main?.bottom ?? 0;
  const drop = new Map<number, PruneResult["removed"][number]["reason"]>();
  for (const g of groups) {
    const reason = g.parts.length === 1 ? "isolated" : g.parts.length < minParts ? "small-group" : g.bottom > ground + gap ? "floating" : null;
    if (reason) for (const i of g.parts) drop.set(i, reason);
  }
  return { kept: placements.filter((_, i) => !drop.has(i)), removed: [...drop].map(([index, reason]) => ({ index, reason })).sort((a, b) => a.index - b.index) };
}

export interface EnvelopeOptions {
  isWall?: (p: SynthesizedPlacement) => boolean;
  isRoof?: (p: SynthesizedPlacement) => boolean;
  /** Share of a side's length its walls must cover (default 0.55: real footprints are L-shaped and offset, so a box-wide wall is too strict; measured on the village preview). */
  coverage?: number;
  /**
   * How far in from the footprint's edge a wall may stand and still count as that side's, metres (default half the
   * footprint's depth across that side: an L-, T- or stepped plan sets part of a side back; measured on the village preview).
   */
  reach?: number;
}

export interface EnvelopeReport {
  closed: boolean;
  /** What is missing: "north wall" (+z), "south wall" (-z), "east wall" (+x), "west wall" (-x), "roof". */
  missing: string[];
}

const WALL = /wall|facade|fa[cç]ade|palisade/i;
const ROOF = /roof|ceiling|vault|thatch/i;

/**
 * Whether one building's parts close: wall parts covering each side of its footprint, and a roof above. Run it on a
 * connected group, not a whole village.
 */
export function envelopeReport(parts: readonly SynthesizedPlacement[], o: EnvelopeOptions = {}): EnvelopeReport {
  const isWall = o.isWall ?? ((p: SynthesizedPlacement) => WALL.test(p.category) || WALL.test(p.partId));
  const isRoof = o.isRoof ?? ((p: SynthesizedPlacement) => ROOF.test(p.category) || ROOF.test(p.partId));
  const coverage = o.coverage ?? 0.55;
  const boxes = parts.map(placementBox);
  const min = [Infinity, Infinity];
  const max = [-Infinity, -Infinity];
  // The footprint is what the walls enclose (stairs, porches and props around it do not move the walls).
  const walls = boxes.filter((_, i) => isWall(parts[i]!));
  for (const b of walls.length > 0 ? walls : boxes) {
    min[0] = Math.min(min[0]!, b.min[0]);
    min[1] = Math.min(min[1]!, b.min[2]);
    max[0] = Math.max(max[0]!, b.max[0]);
    max[1] = Math.max(max[1]!, b.max[2]);
  }
  const missing: string[] = [];
  const [w, d] = [max[0]! - min[0]!, max[1]! - min[1]!];
  const sides: Array<[string, number, number, number, (b: Aabb) => number, (b: Aabb) => [number, number]]> = [
    ["north wall", max[1]!, w, d, (b) => b.max[2], (b) => [b.min[0], b.max[0]]],
    ["south wall", min[1]!, w, d, (b) => b.min[2], (b) => [b.min[0], b.max[0]]],
    ["east wall", max[0]!, d, w, (b) => b.max[0], (b) => [b.min[2], b.max[2]]],
    ["west wall", min[0]!, d, w, (b) => b.min[0], (b) => [b.min[2], b.max[2]]],
  ];
  for (const [name, edge, length, depth, along, span] of sides) {
    const reach = o.reach ?? depth / 2;
    // The walls on this side, their extents merged so overlapping parts are not counted twice.
    const spans = parts.flatMap((p, i) => (isWall(p) && Math.abs(along(boxes[i]!) - edge) <= reach ? [span(boxes[i]!)] : [])).sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = -Infinity;
    for (const [a, b] of spans) {
      covered += Math.max(0, b - Math.max(a, end));
      end = Math.max(end, b);
    }
    if (length <= 0 || covered < length * coverage) missing.push(name);
  }
  if (!parts.some(isRoof)) missing.push("roof");
  return { closed: missing.length === 0, missing };
}
