/**
 * The attack sim: three probes, one per tactic in the matrix.
 *
 *  - charge: Dijkstra over surface movement costs from every map edge to
 *    the gate (or barbican). What matters is the shape of the cheapest
 *    path: a long final straight run is a charge lane.
 *  - ladders: wall-face coverage. Sample points just outside each wall
 *    face; a point is covered if some firing position (tower, gate, core)
 *    is in range with line of sight. Uncovered stretches are dead ground.
 *  - mining: for each tower and the gate, is there adjacent ground a sap
 *    can start in — diggable soil with the water table below tunnel
 *    depth, so the tunnel does not flood? This is the hydrology query in
 *    baked form.
 *
 * Everything is a pure function of the settlement: same input, same
 * analysis, which is what makes the fortify loop deterministic.
 */

import {
  TUNNEL_DEPTH,
  idx,
  inBounds,
  neighbours4,
  tx,
  ty,
  type FaceId,
  type Settlement,
} from "./model.js";
import { DEFAULT_MATRIX, type Matrix, type TacticId, type WeaknessKind, type WeaknessSite } from "./matrix.js";

export interface Weakness {
  kind: WeaknessKind;
  site: WeaknessSite;
  /** tactic weight × local exposure, 0..1. Comparable across kinds. */
  severity: number;
  detail: string;
}

export interface ApproachInfo {
  /** Tile indices, map edge → target, or null when unreachable. */
  path: number[] | null;
  cost: number;
  /** Direction changes along the path. */
  turns: number;
  /** Tiles in the final straight segment, including the target tile. */
  finalStraight: number;
}

export interface Analysis {
  /** Exposure per tactic, 0 (safe) .. 1 (wide open). */
  exposures: Record<TacticId, number>;
  /** Weighted mean of the per-tactic exposures. */
  total: number;
  weaknesses: Weakness[];
  approach: ApproachInfo;
}

/** Surface movement cost per terrain; Infinity = impassable. */
function surfaceCost(s: Settlement, i: number): number {
  if (s.moat.has(i) || s.islands.has(i)) return Infinity;
  if (s.walls.has(i) && i !== s.gate && i !== s.barbican) return Infinity;
  switch (s.grid.tiles[i].terrain) {
    case "road":
    case "land":
      return 1;
    case "marsh":
      return 6;
    case "water":
      return Infinity;
  }
}

/** Dijkstra from the given sources to the target; returns the cheapest path. */
export function cheapestApproach(
  s: Settlement,
  target: number,
  opts: { sources?: number[]; cost?: (s: Settlement, i: number) => number } = {},
): ApproachInfo {
  const g = s.grid;
  const n = g.w * g.h;
  const cost = opts.cost ?? surfaceCost;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  // Default sources: every border tile is a potential landing / muster point.
  const sources =
    opts.sources ??
    (() => {
      const out: number[] = [];
      for (let x = 0; x < g.w; x++) out.push(idx(g, x, 0), idx(g, x, g.h - 1));
      for (let y = 0; y < g.h; y++) out.push(idx(g, 0, y), idx(g, g.w - 1, y));
      return out;
    })();
  for (const i of sources) dist[i] = 0;
  // O(n^2) Dijkstra: the bake grids are small and this stays dependency-free.
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u === -1 || u === target) break;
    done[u] = 1;
    for (const v of neighbours4(g, u)) {
      const c = cost(s, v);
      if (!Number.isFinite(c)) continue;
      const nd = dist[u] + c;
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
      }
    }
  }
  if (!Number.isFinite(dist[target])) return { path: null, cost: Infinity, turns: 0, finalStraight: 0 };
  const path: number[] = [];
  for (let cur = target; cur !== -1; cur = prev[cur]) path.push(cur);
  path.reverse();
  // Direction changes + final straight run, in tile steps.
  let turns = 0;
  let run = 1;
  let finalStraight = 1;
  for (let k = 2; k < path.length; k++) {
    const dPrev = path[k - 1] - path[k - 2];
    const dCur = path[k] - path[k - 1];
    if (dCur !== dPrev) {
      turns++;
      run = 1;
    } else {
      run++;
    }
    if (k === path.length - 1) finalStraight = run + 1;
  }
  if (path.length === 2) finalStraight = 2;
  return { path, cost: dist[target], turns, finalStraight };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * The charge probe walks the approach corridor: formed bodies muster on
 * the gate's side of the map and prefer the road — broken ground doubles
 * their cost, water stops them. (Cross-country infiltration is a
 * different tactic's problem.)
 */
function corridorCost(s: Settlement, i: number): number {
  if (s.moat.has(i) || s.islands.has(i)) return Infinity;
  if (s.walls.has(i) && i !== s.gate && i !== s.barbican) return Infinity;
  switch (s.grid.tiles[i].terrain) {
    case "road":
      return 1;
    case "land":
      return 2;
    case "marsh":
      return 6;
    case "water":
      return Infinity;
  }
}

/** Border tiles on the gate's side of the map. */
function gateSideSources(s: Settlement): number[] {
  const g = s.grid;
  const faces = wallFaces(s);
  const gy = ty(g, s.gate);
  const gx = tx(g, s.gate);
  const northY = faces.north.length ? ty(g, faces.north[0]) : 0;
  const southY = faces.south.length ? ty(g, faces.south[0]) : g.h - 1;
  const westX = faces.west.length ? tx(g, faces.west[0]) : 0;
  const eastX = faces.east.length ? tx(g, faces.east[0]) : g.w - 1;
  const out: number[] = [];
  if (gy === southY) for (let x = 0; x < g.w; x++) out.push(idx(g, x, g.h - 1));
  else if (gy === northY) for (let x = 0; x < g.w; x++) out.push(idx(g, x, 0));
  else if (gx === westX) for (let y = 0; y < g.h; y++) out.push(idx(g, 0, y));
  else if (gx === eastX) for (let y = 0; y < g.h; y++) out.push(idx(g, g.w - 1, y));
  return out;
}

/** Charge exposure from the approach shape: long final straight = lane. */
export function chargeExposure(a: ApproachInfo, hasBarbican: boolean): number {
  if (a.path === null) return 0; // No way in at all.
  let e = clamp01((a.finalStraight - 2) / 6);
  if (hasBarbican) e *= 0.35; // The charge must stop and fight twice.
  return e;
}

/** Tower archers shoot furthest; gate and core positions are shorter-ranged. */
export const TOWER_RANGE = 7;
export const POSITION_RANGE = 6;

/** Grid raycast (Bresenham): true if no *tower* tile blocks the line. */
export function lineOfSight(s: Settlement, x0: number, y0: number, x1: number, y1: number): boolean {
  const towerTiles = new Set(s.towers.map((t) => idx(s.grid, t.x, t.y)));
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    const isEndpoint = (x === x0 && y === y0) || (x === x1 && y === y1);
    if (!isEndpoint && towerTiles.has(idx(s.grid, x, y))) return false;
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

interface FiringPosition {
  x: number;
  y: number;
  range: number;
}

function firingPositions(s: Settlement): FiringPosition[] {
  const out: FiringPosition[] = s.towers.map((t) => ({ x: t.x, y: t.y, range: TOWER_RANGE }));
  out.push({ x: tx(s.grid, s.gate), y: ty(s.grid, s.gate), range: POSITION_RANGE });
  out.push({ x: tx(s.grid, s.core), y: ty(s.grid, s.core), range: POSITION_RANGE });
  if (s.barbican !== null) out.push({ x: tx(s.grid, s.barbican), y: ty(s.grid, s.barbican), range: POSITION_RANGE });
  return out;
}

/** Wall faces from the wall set's bounding box. */
export function wallFaces(s: Settlement): Record<FaceId, number[]> {
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const i of s.walls) {
    x0 = Math.min(x0, tx(s.grid, i));
    x1 = Math.max(x1, tx(s.grid, i));
    y0 = Math.min(y0, ty(s.grid, i));
    y1 = Math.max(y1, ty(s.grid, i));
  }
  const faces: Record<FaceId, number[]> = { north: [], south: [], east: [], west: [] };
  for (const i of s.walls) {
    const x = tx(s.grid, i);
    const y = ty(s.grid, i);
    if (y === y0) faces.north.push(i);
    if (y === y1) faces.south.push(i);
    if (x === x0) faces.west.push(i);
    if (x === x1) faces.east.push(i);
  }
  return faces;
}

/** Sampled points just outside `face`, split by coverage. */
export function faceSamples(s: Settlement, face: FaceId): { covered: Array<{ x: number; y: number }>; dead: Array<{ x: number; y: number }> } {
  const g = s.grid;
  const tiles = wallFaces(s)[face];
  const positions = firingPositions(s);
  const covered: Array<{ x: number; y: number }> = [];
  const dead: Array<{ x: number; y: number }> = [];
  for (let k = 0; k < tiles.length; k += 2) {
    const i = tiles[k];
    const x = tx(g, i);
    const y = ty(g, i);
    // Sample two tiles outside the face.
    const ox = face === "west" ? x - 2 : face === "east" ? x + 2 : x;
    const oy = face === "north" ? y - 2 : face === "south" ? y + 2 : y;
    if (!inBounds(g, ox, oy)) continue;
    const isCovered = positions.some((p) => {
      const d = Math.hypot(p.x - ox, p.y - oy);
      return d <= p.range && lineOfSight(s, p.x, p.y, ox, oy);
    });
    (isCovered ? covered : dead).push({ x: ox, y: oy });
  }
  return { covered, dead };
}

/** Fraction of sampled points outside `face` that no firing position covers. */
export function faceDeadFraction(s: Settlement, face: FaceId): number {
  const { covered, dead } = faceSamples(s, face);
  const total = covered.length + dead.length;
  return total === 0 ? 0 : dead.length / total;
}

/** Can a sap be dug against the structure at (x, y)? Checked on the
 *  ground just outside it: diggable, and dry at tunnel depth. */
export function underminable(s: Settlement, x: number, y: number): boolean {
  const g = s.grid;
  for (const n of neighbours4(g, idx(g, x, y))) {
    if (s.walls.has(n)) continue;
    if (s.moat.has(n)) continue; // Already flooded: saps drown.
    const t = g.tiles[n];
    if (t.terrain === "water") continue;
    if (t.diggable && t.waterDepth > TUNNEL_DEPTH) return true;
  }
  return false;
}

/** Could a moat be flooded around (x, y)? Needs a water source within
 *  diversion distance (Chebyshev 3) — a pond, river, or existing moat. */
export function moatFeasible(s: Settlement, x: number, y: number): boolean {
  const g = s.grid;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(g, nx, ny)) continue;
      const i = idx(g, nx, ny);
      if (g.tiles[i].terrain === "water" || s.moat.has(i)) return true;
    }
  }
  return false;
}

/** Run every probe in the matrix and report exposures + weaknesses. */
export function analyze(s: Settlement, matrix: Matrix = DEFAULT_MATRIX): Analysis {
  const weight = (id: TacticId): number => matrix.tactics.find((t) => t.id === id)?.weight ?? 0;
  const target = s.barbican ?? s.gate;
  const approach = cheapestApproach(s, target, { sources: gateSideSources(s), cost: corridorCost });

  const weaknesses: Weakness[] = [];

  // charge → straight-charge
  const charge = chargeExposure(approach, s.barbican !== null);
  if (charge > 0) {
    weaknesses.push({
      kind: "straight-charge",
      site: { kind: "approach" },
      severity: weight("charge") * charge,
      detail: `cheapest approach ends in a ${approach.finalStraight}-tile straight run at the ${s.barbican !== null ? "barbican" : "gate"}`,
    });
  }

  // ladders → dead-ground, per face
  let worstFace = 0;
  for (const face of ["north", "south", "east", "west"] as FaceId[]) {
    const frac = faceDeadFraction(s, face);
    worstFace = Math.max(worstFace, frac);
    if (frac > 0) {
      weaknesses.push({
        kind: "dead-ground",
        site: { kind: "face", face },
        severity: weight("ladders") * frac,
        detail: `${Math.round(frac * 100)}% of the ${face} face is dead ground`,
      });
    }
  }

  // mining → undermine, per structure. Round towers are exempt: no
  // corner to collapse and a splayed, rock-footed base (the Rochester
  // lesson) — the matrix's round-tower counter works by this rule.
  const structures: Array<{ x: number; y: number; structure: "tower" | "gate" }> = [
    ...s.towers
      .filter((t) => t.form === "square")
      .map((t) => ({ x: t.x, y: t.y, structure: "tower" as const })),
    { x: tx(s.grid, s.gate), y: ty(s.grid, s.gate), structure: "gate" as const },
  ];
  let undermined = 0;
  for (const st of structures) {
    if (underminable(s, st.x, st.y)) {
      undermined++;
      weaknesses.push({
        kind: "undermine",
        site: { kind: "structure", x: st.x, y: st.y, structure: st.structure },
        severity: weight("mining"),
        detail: `${st.structure} at ${st.x},${st.y} can be sapped (dry, diggable soil)`,
      });
    }
  }
  const mining = s.towers.length + 1 === 0 ? 0 : undermined / (s.towers.length + 1);

  weaknesses.sort((a, b) => b.severity - a.severity);

  const exposures: Record<TacticId, number> = { charge, ladders: worstFace, mining };
  const wSum = matrix.tactics.reduce((acc, t) => acc + t.weight, 0);
  const total = matrix.tactics.reduce((acc, t) => acc + t.weight * exposures[t.id], 0) / (wSum || 1);
  return { exposures, total, weaknesses, approach };
}
