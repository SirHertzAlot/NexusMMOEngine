/**
 * The places between the towns (roadmap SG7, SG8): the routes that join the
 * towns, what stands along them, and the homesteads in the land between.
 *
 *  - Routes: the towns are joined as a network (a minimum spanning tree plus a
 *    few extra links), each route walked over the survey's ground, round water
 *    and steep slopes, so a route is a line a person could follow.
 *  - Along a route: guard outposts at intervals; an inn only beside an outpost
 *    (the guards keep bandits, raiders, thieves and wildlife off it); shacks
 *    and camp sites, which have no guard, between them.
 *  - Homesteads: one family of up to ten on a farm or ranch by itself, on flat
 *    green land between the towns and not far from a route.
 *
 * Pure: the terrain and towns go in, a plan comes out, and nothing here draws a
 * random number except from the seed. The plan is a manifest of positions and
 * kinds; building the places (scenes, people) is a later step.
 */

import { z } from "zod";
import { canonical, contentHash } from "./hash.js";
import { Streams } from "./rng.js";
import { hashOf } from "./schedule.js";
import type { TerrainFields } from "./sites.js";

export const PLACE_KINDS = ["guard_outpost", "inn", "shack", "camp_site", "homestead"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

const Pos = z.int().positive();
const Metres = z.number().positive();

export const PlaceRulesSchema = z.strictObject({
  routes: z.strictObject({
    /** Links beyond the spanning tree: each town also joins its nearest neighbours not yet linked to it, up to this many. */
    extraLinksPerTown: z.int().min(0).default(1),
    /** Towns farther apart than this (km) are not linked by an extra link. */
    maxExtraLinkKm: Metres.default(6),
    /** Cells of the survey per route-finding step. */
    stride: Pos.default(4),
    /** The steepest ground a route follows, degrees. */
    walkSlopeDeg: z.number().positive().default(25),
    /** A river costs this many times the walk over dry ground (a ford). */
    riverCost: z.number().min(1).default(8),
    /** Walking an existing route costs this share of the walk over open ground, so routes run together where the towns lie in line. */
    roadDiscount: z.number().positive().max(1).default(0.35),
  }),
  roadside: z.strictObject({
    /** Guard outposts stand this far apart along a route, metres. */
    outpostSpacingM: Metres.default(2400),
    /** Nothing roadside stands this close to a town, metres. */
    townClearM: Metres.default(350),
    /** An inn needs a town at least this far off (a day's walk breaks here), metres. */
    innMinTownDistM: Metres.default(900),
    /** An inn stands this close to its guard outpost, metres. */
    innBesideOutpostM: Metres.default(70),
    /** Shacks stand this far apart along a route, metres. */
    shackSpacingM: Metres.default(1300),
    /** And this far to the side of it (min, max), metres. */
    shackOffsetM: z.tuple([Metres, Metres]).default([25, 60]),
    /** Camp sites stand this far apart along a route, metres. */
    campSpacingM: Metres.default(2600),
    /** A camp site prefers ground this close to fresh water or the sea, metres. */
    campWaterM: Metres.default(250),
    /** A camp site is at least this far from an inn or outpost: it is the unguarded alternative. */
    campClearOfGuardM: Metres.default(700),
  }),
  homesteads: z.strictObject({
    /** Homesteads per town (the plan makes towns x this, as many as fit). */
    perTown: z.int().min(0).default(3),
    familyMin: Pos.default(2),
    familyMax: Pos.default(10),
    /** Homesteads are at least this far from each other and from any town, metres. */
    spacingM: Metres.default(700),
    townClearM: Metres.default(700),
    /** And between this far from a route and that far (min, max), metres: between the towns, not out of reach. */
    routeBandM: z.tuple([Metres, Metres]).default([120, 1400]),
    /** The steepest ground, rise over run in permille, and the clear ground round it, metres. */
    maxSlopePermille: Pos.default(100),
    clearM: Metres.default(48),
    /** Biomes a family farms, and the ones open enough to ranch (share of the land round it at least `ranchShare`). */
    farmBiomes: z.array(z.string()).default(["plains", "forest", "rainforest"]),
    ranchBiomes: z.array(z.string()).default(["plains"]),
    ranchShare: z.number().min(0).max(1).default(0.7),
  }),
});
export type PlaceRules = z.infer<typeof PlaceRulesSchema>;

export const DEFAULT_PLACE_RULES: PlaceRules = PlaceRulesSchema.parse({ routes: {}, roadside: {}, homesteads: {} });

export interface PlaceTown {
  id: string;
  /** The town's centre, world metres. */
  x: number;
  z: number;
}

export interface PlaceRoute {
  id: string;
  from: string;
  to: string;
  lengthM: number;
  /** The route's line, world metres, whole numbers. */
  points: Array<[number, number]>;
}

export interface Place {
  id: string;
  kind: PlaceKind;
  x: number;
  z: number;
  /** The route it stands on (roadside places). */
  route?: string;
  /** An inn: the guard outpost beside it. */
  guardedBy?: string;
  /** A homesteads: the family's size, and what it works. */
  family?: number;
  works?: "farm" | "ranch";
  /** The people who live and work here (homesteads: the family; an inn: its keeper; an outpost: its guards). Baked, so they are the same on every boot. */
  members?: PlaceMember[];
}

/** One person of a place: a baked npc whose home and workplace are the place (or its field). */
export interface PlaceMember {
  id: string;
  household: string;
  home: string;
  cohort: "child" | "adolescent" | "adult" | "elder";
  class: string;
  role: string;
  /** Where they work: the place itself, or a homestead's field or pen (`<id>-farm`, `<id>-ranch`). */
  workplace?: string;
}

/**
 * The people of a place, derived from its id alone (no random stream, so planning is unchanged and the
 * same place always has the same people). A homestead's family is its `family` count: an adult head and
 * the rest by the town demographics' age mix, the grown working the farm or ranch and the young and old
 * about the house. An inn has a keeper and a hand; a guard outpost three guards.
 */
export function placeMembers(p: Pick<Place, "id" | "kind" | "family" | "works">): PlaceMember[] {
  const member = (i: number, cohort: PlaceMember["cohort"], cls: string, role: string, workplace?: string): PlaceMember => ({
    id: `npc_${p.id}_${String(i).padStart(2, "0")}`,
    household: p.id,
    home: p.id,
    cohort,
    class: cls,
    role,
    ...(workplace ? { workplace } : {}),
  });
  if (p.kind === "inn") return [member(0, "adult", "merchant", "innkeeper", p.id), member(1, "adult", "peasant", "inn hand", p.id)];
  if (p.kind === "guard_outpost") return [0, 1, 2].map((i) => member(i, "adult", "guard", "outpost guard", p.id));
  if (p.kind !== "homestead" || !p.family) return [];
  const field = `${p.id}-${p.works ?? "farm"}`;
  const job = p.works === "ranch" ? "rancher" : "farmer";
  return Array.from({ length: p.family }, (_, i) => {
    if (i === 0) return member(i, "adult", "peasant", job, field); // the head of the household
    const r = (hashOf(`${p.id}|${i}`) % 1000) / 1000;
    // The age mix of the town demographics: 28% children, 17% adolescents, 41% adults, 14% elders.
    if (r < 0.28) return member(i, "child", "peasant", "child");
    if (r < 0.45) return member(i, "adolescent", "peasant", job, field);
    if (r < 0.86) return member(i, "adult", "peasant", job, field);
    return member(i, "elder", "peasant", "elder");
  });
}

export interface PlacesPlan {
  format: "places/1";
  rulesVersion: string;
  seed: number;
  towns: PlaceTown[];
  routes: PlaceRoute[];
  places: Place[];
  counts: Record<PlaceKind, number>;
  hash: string;
}

const dist = (ax: number, az: number, bx: number, bz: number): number => Math.hypot(ax - bx, az - bz);

/** A binary min-heap of [priority, value]. */
class Heap {
  private readonly a: Array<[number, number]> = [];
  get size(): number {
    return this.a.length;
  }
  push(p: number, v: number): void {
    const a = this.a;
    a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (a[up]![0] <= a[i]![0]) break;
      [a[up], a[i]] = [a[i]!, a[up]!];
      i = up;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/** The ground the planner reads: dry land, rivers, slope, biome, by world position. */
class Ground {
  readonly W: number;
  readonly D: number;
  readonly cell: number;
  constructor(readonly t: TerrainFields) {
    this.W = t.grid.width;
    this.D = t.grid.depth;
    this.cell = t.grid.cell;
  }
  u(x: number): number {
    return Math.round((x - this.t.grid.originX) / this.cell);
  }
  v(z: number): number {
    return Math.round((z - this.t.grid.originZ) / this.cell);
  }
  inside(u: number, v: number): boolean {
    return u >= 0 && v >= 0 && u < this.W && v < this.D;
  }
  /** Dry land: not water, river or ice, and above the sea. */
  dryCell(u: number, v: number): boolean {
    if (!this.inside(u, v)) return false;
    const i = v * this.W + u;
    return !this.t.water[i] && !this.t.river[i] && !this.t.ice?.[i] && this.t.height[i]! > (this.t.seaLevel ?? 0);
  }
  dry(x: number, z: number): boolean {
    return this.dryCell(this.u(x), this.v(z));
  }
  /** Rise over run to the steeper of the four neighbours, permille. */
  slope(u: number, v: number): number {
    const i = v * this.W + u;
    let rise = 0;
    for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const uu = u + du;
      const vv = v + dv;
      if (this.inside(uu, vv)) rise = Math.max(rise, Math.abs(this.t.height[vv * this.W + uu]! - this.t.height[i]!));
    }
    return (rise * 1000) / this.cell;
  }
  biome(u: number, v: number): string {
    return this.t.biomeIds[this.t.biome[v * this.W + u]!]!;
  }
  /** Is any water (sea, lake or river) within `r` cells? */
  /** Blocks of the route grid that earlier routes already walk (route-finding prefers them, so routes share roads). */
  roads: Uint8Array | null = null;
  waterNear(u: number, v: number, r: number): boolean {
    for (let dv = -r; dv <= r; dv++) {
      for (let du = -r; du <= r; du++) {
        const uu = u + du;
        const vv = v + dv;
        if (!this.inside(uu, vv)) continue;
        const i = vv * this.W + uu;
        if (this.t.water[i] || this.t.river[i]) return true;
      }
    }
    return false;
  }
}

/** The walk between two points over the survey's ground, as a line (A* over blocks of `stride` cells); null when none exists. */
function walkRoute(g: Ground, rules: PlaceRules["routes"], a: PlaceTown, b: PlaceTown): Array<[number, number]> | null {
  const s = rules.stride;
  const gw = Math.ceil(g.W / s);
  const gd = Math.ceil(g.D / s);
  const maxRise = Math.tan((rules.walkSlopeDeg * Math.PI) / 180);
  // A block's walking cost over dry ground is 1; steep ground and fords cost more, water and ice cannot be walked.
  const cost = new Float32Array(gw * gd);
  g.roads ??= new Uint8Array(gw * gd);
  const roads = g.roads;
  for (let j = 0; j < gd; j++) {
    for (let i = 0; i < gw; i++) {
      const u = Math.min(g.W - 1, i * s + (s >> 1));
      const v = Math.min(g.D - 1, j * s + (s >> 1));
      const k = v * g.W + u;
      if (g.t.water[k] || g.t.ice?.[k] || g.t.height[k]! <= (g.t.seaLevel ?? 0)) cost[j * gw + i] = -1;
      else if (g.slope(u, v) / 1000 > maxRise) cost[j * gw + i] = -1;
      else cost[j * gw + i] = (g.t.river[k] ? rules.riverCost : 1) * (1 + g.slope(u, v) / 400);
    }
  }
  const node = (x: number, z: number): number => {
    const i = Math.min(gw - 1, Math.max(0, Math.floor(g.u(x) / s)));
    const j = Math.min(gd - 1, Math.max(0, Math.floor(g.v(z) / s)));
    return j * gw + i;
  };
  // A town's centre may stand on a node the survey calls wet or steep: start from the nearest walkable one.
  const nearest = (n: number): number => {
    if (cost[n]! >= 0) return n;
    const ci = n % gw;
    const cj = Math.floor(n / gw);
    for (let r = 1; r < 12; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          const i = ci + di;
          const j = cj + dj;
          if (i >= 0 && j >= 0 && i < gw && j < gd && cost[j * gw + i]! >= 0) return j * gw + i;
        }
      }
    }
    return -1;
  };
  const start = nearest(node(a.x, a.z));
  const goal = nearest(node(b.x, b.z));
  if (start < 0 || goal < 0) return null;
  const stepM = s * g.cell;
  const centre = (n: number): [number, number] => [g.t.grid.originX + ((n % gw) * s + (s >> 1)) * g.cell, g.t.grid.originZ + (Math.floor(n / gw) * s + (s >> 1)) * g.cell];
  const [gx, gz] = centre(goal);
  const best = new Float32Array(gw * gd).fill(Infinity);
  const from = new Int32Array(gw * gd).fill(-1);
  const heap = new Heap();
  best[start] = 0;
  heap.push(0, start);
  while (heap.size) {
    const [, n] = heap.pop();
    if (n === goal) break;
    const ni = n % gw;
    const nj = Math.floor(n / gw);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const i = ni + di;
        const j = nj + dj;
        if (i < 0 || j < 0 || i >= gw || j >= gd) continue;
        const m = j * gw + i;
        if (cost[m]! < 0) continue;
        // No cutting a corner past a blocked block.
        if (di && dj && (cost[nj * gw + i]! < 0 || cost[j * gw + ni]! < 0)) continue;
        const step = (di && dj ? Math.SQRT2 : 1) * stepM * (cost[m]! + cost[n]!) * 0.5 * (roads[m] ? rules.roadDiscount : 1);
        const next = best[n]! + step;
        if (next < best[m]!) {
          best[m] = next;
          from[m] = n;
          const [mx, mz] = centre(m);
          heap.push(next + dist(mx, mz, gx, gz), m);
        }
      }
    }
  }
  if (!Number.isFinite(best[goal]!)) return null;
  const line: Array<[number, number]> = [];
  for (let n = goal; n !== -1; n = from[n]!) {
    line.push(centre(n));
    roads[n] = 1;
  }
  line.reverse();
  line[0] = [a.x, a.z];
  line[line.length - 1] = [b.x, b.z];
  return simplify(line, stepM * 0.6).map(([x, z]) => [Math.round(x), Math.round(z)]);
}

/** Douglas-Peucker: drop points within `tol` metres of the line between their neighbours. */
function simplify(p: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (p.length < 3) return p;
  const [ax, az] = p[0]!;
  const [bx, bz] = p[p.length - 1]!;
  const len = dist(ax, az, bx, bz) || 1;
  let far = 0;
  let at = -1;
  for (let i = 1; i < p.length - 1; i++) {
    const d = Math.abs((bx - ax) * (az - p[i]![1]) - (ax - p[i]![0]) * (bz - az)) / len;
    if (d > far) (far = d), (at = i);
  }
  if (far <= tol) return [p[0]!, p[p.length - 1]!];
  return [...simplify(p.slice(0, at + 1), tol).slice(0, -1), ...simplify(p.slice(at), tol)];
}

const lengthOf = (p: Array<[number, number]>): number => p.reduce((n, q, i) => (i ? n + dist(p[i - 1]![0], p[i - 1]![1], q[0], q[1]) : 0), 0);

/** The point `s` metres along a line, and the unit normal to its left there. */
function along(p: Array<[number, number]>, s: number): { x: number; z: number; nx: number; nz: number } {
  let left = s;
  for (let i = 1; i < p.length; i++) {
    const [ax, az] = p[i - 1]!;
    const [bx, bz] = p[i]!;
    const d = dist(ax, az, bx, bz);
    if (left <= d || i === p.length - 1) {
      const f = d === 0 ? 0 : Math.min(1, left / d);
      return { x: ax + (bx - ax) * f, z: az + (bz - az) * f, nx: d ? -(bz - az) / d : 0, nz: d ? (bx - ax) / d : 1 };
    }
    left -= d;
  }
  return { x: p[0]![0], z: p[0]![1], nx: 0, nz: 1 };
}

/** The shortest distance from a point to a polyline, metres. */
function toLine(p: Array<[number, number]>, x: number, z: number): number {
  let best = Infinity;
  for (let i = 1; i < p.length; i++) {
    const [ax, az] = p[i - 1]!;
    const [bx, bz] = p[i]!;
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const f = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, dist(x, z, ax + dx * f, az + dz * f));
  }
  return best;
}

/** The links of the road network: a minimum spanning tree over the towns' straight distances, plus each town's nearest extras. */
function links(towns: PlaceTown[], rules: PlaceRules["routes"]): Array<[number, number]> {
  const n = towns.length;
  const out = new Map<string, [number, number]>();
  const key = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const add = (a: number, b: number): void => void out.set(key(a, b), a < b ? [a, b] : [b, a]);
  const d = (a: number, b: number): number => dist(towns[a]!.x, towns[a]!.z, towns[b]!.x, towns[b]!.z);
  const inTree = new Array<boolean>(n).fill(false);
  inTree[0] = true;
  for (let k = 1; k < n; k++) {
    let bi = -1;
    let bj = -1;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      if (!inTree[i]) continue;
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue;
        const dd = d(i, j);
        if (dd < bd) (bd = dd), (bi = i), (bj = j);
      }
    }
    inTree[bj] = true;
    add(bi, bj);
  }
  for (let i = 0; i < n; i++) {
    const near = [...Array(n).keys()]
      .filter((j) => j !== i && !out.has(key(i, j)) && d(i, j) <= rules.maxExtraLinkKm * 1000)
      .sort((p, q) => d(i, p) - d(i, q) || p - q);
    for (const j of near.slice(0, rules.extraLinksPerTown)) add(i, j);
  }
  return [...out.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

/** Plan the routes and the places along them and between the towns. */
export function planPlaces(input: { towns: PlaceTown[]; terrain: TerrainFields; seed: number; rules?: PlaceRules; /** The rules file's version, recorded in the plan. */ rulesVersion?: string }): PlacesPlan {
  const rules = input.rules ?? DEFAULT_PLACE_RULES;
  const towns = [...input.towns].sort((a, b) => (a.id < b.id ? -1 : 1));
  const g = new Ground(input.terrain);
  const streams = new Streams(input.seed);
  const places: Place[] = [];
  const routes: PlaceRoute[] = [];
  const nextId = (): string => `P${String(places.length + 1).padStart(4, "0")}`;
  const townDist = (x: number, z: number): number => towns.reduce((m, t) => Math.min(m, dist(x, z, t.x, t.z)), Infinity);
  const nearestOf = (kinds: PlaceKind[], x: number, z: number): number => places.filter((p) => kinds.includes(p.kind)).reduce((m, p) => Math.min(m, dist(x, z, p.x, p.z)), Infinity);

  if (towns.length >= 2) {
    for (const [i, j] of links(towns, rules.routes)) {
      const a = towns[i]!;
      const b = towns[j]!;
      const points = walkRoute(g, rules.routes, a, b);
      if (points) routes.push({ id: `R${String(routes.length + 1).padStart(3, "0")}`, from: a.id, to: b.id, lengthM: Math.round(lengthOf(points)), points });
    }
  }

  const R = rules.roadside;
  const rng = streams.get("places.roadside");
  /** Place `kind` at a point beside the route, nudged to dry ground; null when no dry spot is near. */
  const spot = (r: PlaceRoute, s: number, sideM: number): { x: number; z: number } | null => {
    const q = along(r.points, s);
    for (const [side, push] of [[1, 0], [-1, 0], [1, 25], [-1, 25], [1, 50], [-1, 50]] as const) {
      const x = Math.round(q.x + q.nx * side * (sideM + push));
      const z = Math.round(q.z + q.nz * side * (sideM + push));
      if (g.dry(x, z) && townDist(x, z) >= R.townClearM) return { x, z };
    }
    return null;
  };

  // Guard outposts first: they are what inns hang from.
  for (const r of routes) {
    for (let s = R.outpostSpacingM / 2; s < r.lengthM; s += R.outpostSpacingM) {
      const at = spot(r, s, 20);
      if (!at || nearestOf(["guard_outpost"], at.x, at.z) < R.outpostSpacingM * 0.6) continue;
      places.push({ id: nextId(), kind: "guard_outpost", x: at.x, z: at.z, route: r.id });
    }
  }
  // An inn only beside an outpost and far enough from a town; how near another inn stands does not matter.
  for (const o of [...places]) {
    if (o.kind !== "guard_outpost") continue;
    if (townDist(o.x, o.z) < R.innMinTownDistM) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const x = Math.round(o.x + dx * R.innBesideOutpostM);
      const z = Math.round(o.z + dz * R.innBesideOutpostM);
      if (!g.dry(x, z)) continue;
      places.push({ id: nextId(), kind: "inn", x, z, route: o.route!, guardedBy: o.id });
      break;
    }
  }
  // Camp sites, near water where the route passes it, clear of the guarded places.
  for (const r of routes) {
    for (let s = R.campSpacingM / 2; s < r.lengthM; s += R.campSpacingM) {
      let pick: { x: number; z: number } | null = null;
      let pickWater = false;
      for (let ds = -R.campSpacingM / 4; ds <= R.campSpacingM / 4; ds += R.campSpacingM / 8) {
        const at = spot(r, Math.max(0, Math.min(r.lengthM, s + ds)), 35);
        if (!at) continue;
        const water = g.waterNear(g.u(at.x), g.v(at.z), Math.ceil(R.campWaterM / g.cell));
        if (nearestOf(["inn", "guard_outpost"], at.x, at.z) < R.campClearOfGuardM || nearestOf(["camp_site"], at.x, at.z) < R.campSpacingM * 0.6) continue;
        if (!pick || (water && !pickWater)) (pick = at), (pickWater = water);
      }
      if (pick) places.push({ id: nextId(), kind: "camp_site", x: pick.x, z: pick.z, route: r.id });
    }
  }
  // Shacks along the way, to either side, a little off the road.
  for (const r of routes) {
    for (let s = R.shackSpacingM / 2; s < r.lengthM; s += R.shackSpacingM) {
      const side = R.shackOffsetM[0] + rng.raw() * (R.shackOffsetM[1] - R.shackOffsetM[0]);
      const at = spot(r, s, side);
      if (!at || nearestOf(["shack"], at.x, at.z) < R.shackSpacingM * 0.5) continue;
      if (nearestOf(["guard_outpost", "inn"], at.x, at.z) < 120) continue;
      places.push({ id: nextId(), kind: "shack", x: at.x, z: at.z, route: r.id });
    }
  }

  // Homesteads: flat green land, clear of water, between the towns and within reach of a route.
  const H = rules.homesteads;
  const want = towns.length * H.perTown;
  if (want > 0 && routes.length > 0) {
    const hrng = streams.get("places.homesteads");
    const clearCells = Math.ceil(H.clearM / g.cell);
    const cand: Array<{ x: number; z: number; u: number; v: number }> = [];
    const stepCells = Math.max(1, Math.round(H.spacingM / 3 / g.cell));
    for (let v = clearCells; v < g.D - clearCells; v += stepCells) {
      for (let u = clearCells; u < g.W - clearCells; u += stepCells) {
        if (!g.dryCell(u, v) || g.slope(u, v) > H.maxSlopePermille || !H.farmBiomes.includes(g.biome(u, v))) continue;
        if (g.waterNear(u, v, clearCells)) continue;
        const x = g.t.grid.originX + u * g.cell;
        const z = g.t.grid.originZ + v * g.cell;
        if (townDist(x, z) < H.townClearM) continue;
        const band = routes.reduce((m, r) => Math.min(m, toLine(r.points, x, z)), Infinity);
        if (band < H.routeBandM[0] || band > H.routeBandM[1]) continue;
        cand.push({ x, z, u, v });
      }
    }
    // Shuffle (seeded), then take those that keep their distance.
    for (let i = cand.length - 1; i > 0; i--) {
      const j = Math.floor(hrng.raw() * (i + 1));
      [cand[i], cand[j]] = [cand[j]!, cand[i]!];
    }
    const homes: Place[] = [];
    for (const c of cand) {
      if (homes.length >= want) break;
      if (homes.some((p) => dist(p.x, p.z, c.x, c.z) < H.spacingM) || nearestOf(["guard_outpost", "inn", "shack", "camp_site"], c.x, c.z) < 150) continue;
      // Ranch where the land round it is open (mostly ranch biomes), else a farm.
      let open = 0;
      let all = 0;
      for (let dv = -8; dv <= 8; dv++) {
        for (let du = -8; du <= 8; du++) {
          if (!g.inside(c.u + du, c.v + dv)) continue;
          all++;
          if (H.ranchBiomes.includes(g.biome(c.u + du, c.v + dv))) open++;
        }
      }
      const works = open / all >= H.ranchShare && hrng.raw() < 0.5 ? "ranch" : "farm";
      const family = H.familyMin + Math.floor(hrng.raw() * (H.familyMax - H.familyMin + 1));
      homes.push({ id: "", kind: "homestead", x: Math.round(c.x), z: Math.round(c.z), family, works });
    }
    for (const h of homes) places.push({ ...h, id: nextId() });
  }

  for (let i = 0; i < places.length; i++) {
    const members = placeMembers(places[i]!);
    if (members.length) places[i] = { ...places[i]!, members };
  }
  const counts = Object.fromEntries(PLACE_KINDS.map((k) => [k, places.filter((p) => p.kind === k).length])) as Record<PlaceKind, number>;
  const body = { format: "places/1" as const, rulesVersion: input.rulesVersion ?? "builtin", seed: input.seed, towns, routes, places, counts };
  return { ...body, hash: contentHash(JSON.parse(canonical(body))) };
}
