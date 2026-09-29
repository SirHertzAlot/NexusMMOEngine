/**
 * The dungeon generator: a seed and a few parameters to a complete, fully
 * connected layout (tile grid, rooms with roles and difficulty, corridors,
 * doorways, liquids, props, torches, monster spawn points), as pure data.
 *
 *   scatter → separate → Delaunay → MST + loops → room roles → carve
 *   → liquids and arches → flood fill (connectivity check) → decorate
 *
 * Ported from Dungeon Forge's generator (MIT, © 2026 Majid Manzarpour; see
 * THIRD_PARTY_NOTICES.md), typed and separated from its renderer. The
 * layout is identical to the original's for the same seed and parameters:
 * every random draw happens in the same order.
 *
 * Grid coordinates: x across (width), y down (height), one cell = one tile.
 */

import { delaunay } from "./delaunay.js";
import { makeRng, type Rng } from "./rng.js";
import type { Theme } from "./themes.js";

export const CELL = { void: 0, floor: 1, wall: 2, pool: 3 } as const;

export type RoomType = "entrance" | "combat" | "elite" | "treasure" | "shrine" | "boss";
export type RoomShape = "rect" | "ellipse" | "oct";

export interface Room {
  id: number;
  /** Centre, grid cells. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  size: "s" | "m" | "l";
  shape: RoomShape;
  type: RoomType;
  /** Rooms (graph steps) from the entrance. */
  depth: number;
  /** 0 at the entrance to 1 at the boss. */
  difficulty: number;
  /** Corridors leaving it. */
  degree: number;
  /** A frozen lake fills its middle (frost). */
  lake?: boolean;
  /** A graveyard (grim). */
  grave?: boolean;
}

export interface Corridor {
  a: number;
  b: number;
  /** An extra link beyond the spanning tree (a shortcut). */
  loop: boolean;
  /** On the path from the entrance to the boss. */
  critical: boolean;
}

export interface Prop {
  kind: string;
  x: number;
  y: number;
  /** Radians about the vertical. */
  rot: number;
  scale: number;
  /** The room it belongs to (-1: a corridor). */
  room?: number;
  /** Facing, for wall-mounted props (the floor side). */
  dx?: number;
  dy?: number;
  variant?: number;
  ice?: boolean;
}

export interface Spawn {
  x: number;
  y: number;
  /** 1–3: how strong a monster belongs here. */
  tier: number;
  room: number;
}

export interface Torch {
  /** The wall cell it hangs on, facing the floor at (x + dx, y + dy). */
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export interface Arch {
  /** Centre of a doorway run, grid cells (may be a half cell). */
  x: number;
  y: number;
  /** The run's direction (across the corridor). */
  px: number;
  py: number;
  len: number;
}

export interface DungeonParams {
  seed: number;
  /** Rooms to scatter (12–80 in the original's UI). */
  rooms: number;
  /** Share of leftover Delaunay edges added back as loops. */
  loopChance: number;
  /** 0–1: how heavily rooms are dressed. */
  decorDensity: number;
  /** A theme id. */
  theme: string;
}

export interface Dungeon {
  params: DungeonParams;
  /** The seed actually used (the requested one, or a re-roll if it didn't connect). */
  seed: number;
  attempts: number;
  /** Every floor cell is reachable from the entrance. */
  valid: boolean;
  name: string;
  width: number;
  height: number;
  /** CELL per cell, row-major (y * width + x). */
  grid: Uint8Array;
  /** Room id per cell (-1: not in a room). */
  roomId: Int16Array;
  /** 1 on corridor floor. */
  corridor: Uint8Array;
  /** 1 on corridor cells that open into a room. */
  doorway: Uint8Array;
  /** 1 on frozen-lake floor. */
  lake: Uint8Array;
  /** Walking distance from the entrance, in cells (-1: not floor). */
  distance: Int16Array;
  maxDistance: number;
  rooms: Room[];
  corridors: Corridor[];
  entrance: number;
  boss: number;
  maxDepth: number;
  props: Prop[];
  spawns: Spawn[];
  torches: Torch[];
  /** Liquid cells (CELL.pool). */
  pools: { x: number; y: number }[];
  arches: Arch[];
  stats: { rooms: number; corridors: number; loops: number; criticalPath: number; floorTiles: number };
}

/** Generate a dungeon; if a seed fails to connect, re-roll it (up to 5 tries), as the original does. */
export function generateDungeon(params: DungeonParams, theme: Theme): Dungeon {
  // At least 3 rooms: two are promoted to large ones, plus an entrance distinct from the boss.
  if (!Number.isInteger(params.rooms) || params.rooms < 3) throw new RangeError(`rooms must be a whole number >= 3 (got ${params.rooms})`);
  if (!(params.loopChance >= 0 && params.loopChance <= 1)) throw new RangeError(`loopChance must be in [0, 1] (got ${params.loopChance})`);
  if (!(params.decorDensity >= 0 && params.decorDensity <= 1)) throw new RangeError(`decorDensity must be in [0, 1] (got ${params.decorDensity})`);
  let seed = params.seed >>> 0;
  let d: Dungeon | null = null;
  let attempt = 0;
  while (attempt < 5) {
    d = tryGenerate(seed, params, theme);
    if (d.valid) break;
    seed = (Math.imul(seed, 9301) + 49297) >>> 0;
    attempt++;
  }
  const out = d as Dungeon;
  out.attempts = Math.min(attempt + 1, 5);
  return out;
}

function dungeonName(rng: Rng, th: Theme): string {
  const C = ["Mal", "Vor", "Ash", "Ker", "Ul", "Dra", "Noth", "Zar", "Bel", "Mor", "Gol", "Ith"];
  const D = ["goth", "ath", "ruk", "esh", "mir", "gul", "dan", "oth", "ek", "ash", "uzek", "arim"];
  return `The ${rng.pick(th.nameA)} ${rng.pick(th.nameB)} of ${rng.pick(C)}’${rng.pick(D)}`;
}

function shuffle<T>(rng: Rng, list: T[]): void {
  for (let i = list.length - 1; i > 0; i--) {
    const j = rng.i(0, i);
    const t = list[i];
    list[i] = list[j];
    list[j] = t;
  }
}

function tryGenerate(seed: number, params: DungeonParams, TH: Theme): Dungeon {
  const rng = makeRng(seed);
  const N = params.rooms;

  // -- 1. scatter: rooms in a rough disc, mostly small, a few large --
  const R = Math.sqrt(N) * 4.6;
  const rooms: Room[] = [];
  const large: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = rng.raw();
    let w: number, h: number, size: Room["size"];
    if (t < 0.45) { size = "s"; w = rng.i(5, 7); h = rng.i(5, 7); }
    else if (t < 0.85) { size = "m"; w = rng.i(8, 12); h = rng.i(8, 12); }
    else { size = "l"; w = rng.i(13, 18); h = rng.i(13, 18); large.push(i); }
    const st = rng.raw();
    const shape: RoomShape = st < 0.6 ? "rect" : st < 0.82 ? "ellipse" : "oct";
    const ang = rng.f(0, Math.PI * 2), rad = R * Math.sqrt(rng.raw());
    rooms.push({ id: i, cx: Math.cos(ang) * rad, cy: Math.sin(ang) * rad, w, h, size, shape, type: "combat", depth: 0, difficulty: 0.2, degree: 0 });
  }
  while (large.length < 2) {
    const j = rng.i(0, N - 1);
    if (rooms[j].size !== "l") {
      rooms[j].size = "l";
      rooms[j].w = rng.i(13, 18);
      rooms[j].h = rng.i(13, 18);
      rooms[j].shape = "rect";
      large.push(j);
    }
  }

  // -- 2. separate: overlapping rooms push apart --
  const PAD = 2;
  {
    const CX = new Float64Array(N), CY = new Float64Array(N), HW = new Float64Array(N), HH = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      CX[i] = rooms[i].cx; CY[i] = rooms[i].cy;
      HW[i] = rooms[i].w / 2 + PAD / 2; HH[i] = rooms[i].h / 2 + PAD / 2;
    }
    for (let iter = 0; iter < 300; iter++) {
      let moved = false;
      for (let i = 0; i < N; i++)
        for (let j = i + 1; j < N; j++) {
          const ox = HW[i] + HW[j] - Math.abs(CX[i] - CX[j]);
          if (ox <= 0) continue;
          const oy = HH[i] + HH[j] - Math.abs(CY[i] - CY[j]);
          if (oy <= 0) continue;
          moved = true;
          if (ox < oy) { const s = CX[i] <= CX[j] ? -1 : 1; CX[i] += (s * ox) / 2; CX[j] -= (s * ox) / 2; }
          else { const s = CY[i] <= CY[j] ? -1 : 1; CY[i] += (s * oy) / 2; CY[j] -= (s * oy) / 2; }
        }
      if (!moved) break;
    }
    for (let i = 0; i < N; i++) { rooms[i].cx = Math.round(CX[i]); rooms[i].cy = Math.round(CY[i]); }
  }

  // -- 3. graph: Delaunay → minimum spanning tree → loops --
  const centers = rooms.map((r) => ({ x: r.cx, y: r.cy }));
  let delEdges = delaunay(centers);
  if (delEdges.length === 0) {
    delEdges = [];
    for (let i = 0; i < N - 1; i++) delEdges.push([i, i + 1]);
  }
  const elen = (e: [number, number]): number => Math.hypot(centers[e[0]].x - centers[e[1]].x, centers[e[0]].y - centers[e[1]].y);
  const adj: { b: number; w: number; idx: number }[][] = Array.from({ length: N }, () => []);
  delEdges.forEach((e, idx) => {
    const w = elen(e);
    adj[e[0]].push({ b: e[1], w, idx });
    adj[e[1]].push({ b: e[0], w, idx });
  });
  const inT = new Uint8Array(N);
  inT[0] = 1;
  let inCount = 1;
  const mstIdx = new Set<number>();
  while (inCount < N) {
    let best: { b: number; w: number; idx: number } | null = null;
    for (let a = 0; a < N; a++) if (inT[a]) for (const e of adj[a]) if (!inT[e.b] && (!best || e.w < best.w)) best = e;
    if (!best) break;
    inT[best.b] = 1;
    inCount++;
    mstIdx.add(best.idx);
  }
  if (inCount < N) return invalid(params, seed);

  let mstLenSum = 0;
  for (const i of mstIdx) mstLenSum += elen(delEdges[i]);
  const mstMean = mstLenSum / Math.max(1, mstIdx.size);
  const edges: Corridor[] = [];
  delEdges.forEach((e, idx) => {
    if (mstIdx.has(idx)) edges.push({ a: e[0], b: e[1], loop: false, critical: false });
    else if (elen(e) < mstMean * 2.2 && rng.chance(params.loopChance)) edges.push({ a: e[0], b: e[1], loop: true, critical: false });
  });
  for (const e of edges) { rooms[e.a].degree++; rooms[e.b].degree++; }

  // Dungeons need dead ends: prune loops until there are at least 3 leaves.
  if (N >= 20) {
    let leafCount = 0;
    for (let i = 0; i < N; i++) if (rooms[i].degree === 1) leafCount++;
    while (leafCount < 3) {
      let bi = -1, bs = -1;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (!e.loop) continue;
        const s = (rooms[e.a].degree === 2 ? 1 : 0) + (rooms[e.b].degree === 2 ? 1 : 0);
        const L = Math.hypot(centers[e.a].x - centers[e.b].x, centers[e.a].y - centers[e.b].y);
        const score = s * 10000 + L;
        if (score > bs) { bs = score; bi = i; }
      }
      if (bi < 0) break;
      const e = edges[bi];
      if (--rooms[e.a].degree === 1) leafCount++;
      if (--rooms[e.b].degree === 1) leafCount++;
      edges.splice(bi, 1);
    }
  }

  // -- 4. room roles: boss = biggest; entrance = the leaf farthest from it --
  const gAdj: { b: number; i: number }[][] = Array.from({ length: N }, () => []);
  edges.forEach((e, i) => { gAdj[e.a].push({ b: e.b, i }); gAdj[e.b].push({ b: e.a, i }); });
  let boss = 0;
  for (let i = 1; i < N; i++) if (rooms[i].w * rooms[i].h > rooms[boss].w * rooms[boss].h) boss = i;
  const distFrom = (src: number): Int32Array => {
    const D = new Int32Array(N).fill(-1);
    D[src] = 0;
    const q = [src];
    for (let h = 0; h < q.length; h++) { const a = q[h]; for (const e of gAdj[a]) if (D[e.b] < 0) { D[e.b] = D[a] + 1; q.push(e.b); } }
    return D;
  };
  const dB = distFrom(boss);
  let entrance = -1, bestD = -1;
  for (let i = 0; i < N; i++) if (i !== boss && rooms[i].degree === 1 && dB[i] > bestD) { bestD = dB[i]; entrance = i; }
  if (entrance < 0) for (let i = 0; i < N; i++) if (i !== boss && dB[i] > bestD) { bestD = dB[i]; entrance = i; }

  const dE = distFrom(entrance);
  let maxDepth = 1;
  for (let i = 0; i < N; i++) if (dE[i] > maxDepth) maxDepth = dE[i];
  rooms.forEach((r, i) => { r.depth = Math.max(0, dE[i]); r.difficulty = Math.min(1, 0.15 + 0.85 * (r.depth / maxDepth)); });
  rooms[entrance].type = "entrance"; rooms[entrance].difficulty = 0;
  rooms[boss].type = "boss"; rooms[boss].difficulty = 1;

  const par = new Int32Array(N).fill(-1), pe = new Int32Array(N).fill(-1);
  {
    const q = [entrance], vis = new Uint8Array(N);
    vis[entrance] = 1;
    for (let h = 0; h < q.length; h++) {
      const a = q[h];
      for (const e of gAdj[a]) if (!vis[e.b]) { vis[e.b] = 1; par[e.b] = a; pe[e.b] = e.i; q.push(e.b); }
    }
  }
  const critRooms = new Set<number>();
  let critLen = 0;
  for (let c = boss; c !== -1; c = par[c]) {
    critRooms.add(c);
    if (pe[c] >= 0) { edges[pe[c]].critical = true; critLen++; }
    if (c === entrance) break;
  }
  const leaves: number[] = [];
  for (let i = 0; i < N; i++) if (i !== entrance && i !== boss && rooms[i].degree === 1) leaves.push(i);
  leaves.sort((a, b) => rooms[b].depth - rooms[a].depth);
  leaves.slice(0, 4).forEach((i) => { rooms[i].type = "treasure"; });
  const shrineC: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = rooms[i];
    if (r.type === "combat" && !critRooms.has(i) && r.depth > maxDepth * 0.3 && r.depth < maxDepth * 0.85) shrineC.push(i);
  }
  for (let k = 0; k < 2 && shrineC.length > 0; k++) {
    const j = shrineC.splice(rng.i(0, shrineC.length - 1), 1)[0];
    rooms[j].type = "shrine";
  }
  const eliteC: number[] = [];
  for (const i of critRooms) {
    const r = rooms[i];
    if (r.type === "combat" && r.depth >= maxDepth * 0.55 && r.depth <= maxDepth * 0.85) eliteC.push(i);
  }
  eliteC.sort((a, b) => rooms[a].depth - rooms[b].depth);
  for (let k = 0; k < Math.min(2, eliteC.length); k++) rooms[eliteC[eliteC.length - 1 - k]].type = "elite";

  // -- 4.5 theme rooms: frozen lakes, graveyards --
  if (TH.lakes) {
    const lc: number[] = [];
    for (let i = 0; i < N; i++) { const r = rooms[i]; if ((r.type === "combat" || r.type === "elite") && Math.min(r.w, r.h) >= 9) lc.push(i); }
    for (let k = 0; k < 2 && lc.length > 0; k++) rooms[lc.splice(rng.i(0, lc.length - 1), 1)[0]].lake = true;
  }
  if (TH.graveyards) {
    const gc: number[] = [];
    for (let i = 0; i < N; i++) { const r = rooms[i]; if (r.type === "combat" && r.shape !== "ellipse" && Math.min(r.w, r.h) >= 8) gc.push(i); }
    for (let k = 0; k < 3 && gc.length > 0; k++) rooms[gc.splice(rng.i(0, gc.length - 1), 1)[0]].grave = true;
  }

  // -- 5. carve rooms and corridors into the grid, then wall them in --
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const r of rooms) {
    minX = Math.min(minX, r.cx - Math.ceil(r.w / 2)); maxX = Math.max(maxX, r.cx + Math.ceil(r.w / 2));
    minY = Math.min(minY, r.cy - Math.ceil(r.h / 2)); maxY = Math.max(maxY, r.cy + Math.ceil(r.h / 2));
  }
  const PADG = 5, offX = PADG - minX, offY = PADG - minY;
  const W = maxX - minX + PADG * 2 + 1, H = maxY - minY + PADG * 2 + 1;
  for (const r of rooms) { r.cx += offX; r.cy += offY; }

  const grid = new Uint8Array(W * H);
  const roomId = new Int16Array(W * H).fill(-1);
  const corridor = new Uint8Array(W * H);
  const idx = (x: number, y: number): number => y * W + x;
  const inB = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;
  const { floor: FLOOR, wall: WALL, pool: POOL, void: VOID } = CELL;

  for (const r of rooms) {
    const rx = r.w / 2, ry = r.h / 2, sh = r.shape, ch = Math.min(rx, ry) * 0.55;
    const irx2 = 1 / (rx * rx), iry2 = 1 / (ry * ry);
    const y0 = Math.max(0, Math.floor(r.cy - ry)), y1 = Math.min(H - 1, Math.ceil(r.cy + ry));
    const x0 = Math.max(0, Math.floor(r.cx - rx)), x1 = Math.min(W - 1, Math.ceil(r.cx + rx));
    for (let y = y0; y <= y1; y++) {
      const dy = y - r.cy, ady = Math.abs(dy), row = y * W;
      if (ady > ry) continue;
      for (let x = x0; x <= x1; x++) {
        const dx = x - r.cx, adx = Math.abs(dx);
        if (adx > rx) continue;
        let ok = true;
        if (sh === "ellipse") ok = dx * dx * irx2 + dy * dy * iry2 <= 1.0;
        else if (sh === "oct") ok = adx <= rx - ch || ady <= ry - ch || adx - (rx - ch) + (ady - (ry - ch)) <= ch;
        if (ok) { const c = row + x; grid[c] = FLOOR; roomId[c] = r.id; }
      }
    }
  }

  const stamp = (x: number, y: number): void => {
    if (inB(x, y) && grid[idx(x, y)] !== FLOOR) { grid[idx(x, y)] = FLOOR; corridor[idx(x, y)] = 1; }
  };
  const offs = (w: number): number[] => (w === 1 ? [0] : w === 2 ? [0, 1] : [-1, 0, 1]);
  const hLine = (x0: number, x1: number, y: number, w: number): void => {
    const o = offs(w);
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (const k of o) stamp(x, y + k);
  };
  const vLine = (y0: number, y1: number, x: number, w: number): void => {
    const o = offs(w);
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (const k of o) stamp(x + k, y);
  };
  for (const e of edges) {
    const A = rooms[e.a], B = rooms[e.b];
    let w = e.critical ? 3 : 2;
    if (!e.critical && (rooms[e.a].type === "treasure" || rooms[e.b].type === "treasure") && rng.chance(0.4)) w = 1;
    const dx = Math.abs(A.cx - B.cx), dy = Math.abs(A.cy - B.cy);
    const ovX = Math.min(A.cx + A.w / 2, B.cx + B.w / 2) - Math.max(A.cx - A.w / 2, B.cx - B.w / 2);
    const ovY = Math.min(A.cy + A.h / 2, B.cy + B.h / 2) - Math.max(A.cy - A.h / 2, B.cy - B.h / 2);
    if (ovX >= w + 2 && dy > 0) {
      const x = Math.round((Math.max(A.cx - A.w / 2, B.cx - B.w / 2) + Math.min(A.cx + A.w / 2, B.cx + B.w / 2)) / 2);
      vLine(A.cy, B.cy, x, w);
    } else if (ovY >= w + 2 && dx > 0) {
      const y = Math.round((Math.max(A.cy - A.h / 2, B.cy - B.h / 2) + Math.min(A.cy + A.h / 2, B.cy + B.h / 2)) / 2);
      hLine(A.cx, B.cx, y, w);
    } else if (rng.chance(0.5)) { hLine(A.cx, B.cx, A.cy, w); vLine(A.cy, B.cy, B.cx, w); }
    else { vLine(A.cy, B.cy, A.cx, w); hLine(A.cx, B.cx, B.cy, w); }
  }

  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (grid[row + x] !== FLOOR) continue;
      const ya = Math.max(0, y - 1), yb = Math.min(H - 1, y + 1), xa = Math.max(0, x - 1), xb = Math.min(W - 1, x + 1);
      for (let ny = ya; ny <= yb; ny++) {
        const nrow = ny * W;
        for (let nx = xa; nx <= xb; nx++) if (grid[nrow + nx] === VOID) grid[nrow + nx] = WALL;
      }
    }
  }

  const doorway = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const c = row + x;
      if (!corridor[c]) continue;
      if ((x < W - 1 && roomId[c + 1] >= 0) || (x > 0 && roomId[c - 1] >= 0) || (y < H - 1 && roomId[c + W] >= 0) || (y > 0 && roomId[c - W] >= 0)) doorway[c] = 1;
    }
  }

  // -- 5.5 liquids: wall pockets and floor pits (never split a room), frozen lakes, arches --
  const pools: { x: number; y: number }[] = [];
  if (TH.pools && TH.pools.amount > 0) {
    const nearDoorC = (x: number, y: number, d: number): boolean => {
      for (let oy = -d; oy <= d; oy++) for (let ox = -d; ox <= d; ox++) {
        const nx = x + ox, ny = y + oy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && doorway[idx(nx, ny)]) return true;
      }
      return false;
    };
    const cand: { x: number; y: number }[] = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const c = idx(x, y);
      if (grid[c] !== WALL || nearDoorC(x, y, 2)) continue;
      let nf = 0;
      if (grid[c + 1] === FLOOR) nf++;
      if (grid[c - 1] === FLOOR) nf++;
      if (grid[c + W] === FLOOR) nf++;
      if (grid[c - W] === FLOOR) nf++;
      if (nf === 1) cand.push({ x, y });
    }
    shuffle(rng, cand);
    const target = Math.round(cand.length * TH.pools.amount);
    for (const s of cand) {
      if (pools.length >= target) break;
      let close = false;
      for (const p of pools) if (Math.max(Math.abs(p.x - s.x), Math.abs(p.y - s.y)) < 3) { close = true; break; }
      if (close) continue;
      grid[idx(s.x, s.y)] = POOL;
      pools.push({ x: s.x, y: s.y });
    }
    for (const p of pools)
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const nx = p.x + ox, ny = p.y + oy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && grid[idx(nx, ny)] === VOID) grid[idx(nx, ny)] = WALL;
      }
  }
  if (TH.pools && TH.pools.pits) {
    for (const r of rooms) {
      if ((r.type !== "combat" && r.type !== "elite") || r.lake || r.grave) continue;
      let n = Math.min(TH.pools.pits, Math.floor((r.w * r.h) / 45) + 1), guard = 0;
      while (n > 0 && guard++ < 40) {
        const x = rng.i(Math.floor(r.cx - r.w / 2) + 2, Math.ceil(r.cx + r.w / 2) - 2);
        const y = rng.i(Math.floor(r.cy - r.h / 2) + 2, Math.ceil(r.cy + r.h / 2) - 2);
        if (!inB(x, y)) continue;
        const c = idx(x, y);
        if (roomId[c] !== r.id || grid[c] !== FLOOR || doorway[c]) continue;
        let ok = true;
        for (let oy = -1; oy <= 1 && ok; oy++) for (let ox = -1; ox <= 1; ox++) if (grid[idx(x + ox, y + oy)] !== FLOOR) { ok = false; break; }
        if (ok) for (const p of pools) if (Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) < 4) { ok = false; break; }
        if (!ok) continue;
        grid[c] = POOL;
        pools.push({ x, y });
        n--;
      }
    }
  }
  const lake = new Uint8Array(W * H);
  const lakeCells: { x: number; y: number }[] = [];
  for (const r of rooms) {
    if (!r.lake) continue;
    for (let y = Math.floor(r.cy - r.h / 2) + 2; y <= Math.ceil(r.cy + r.h / 2) - 2; y++)
      for (let x = Math.floor(r.cx - r.w / 2) + 2; x <= Math.ceil(r.cx + r.w / 2) - 2; x++) {
        if (!inB(x, y)) continue;
        const c = idx(x, y);
        if (roomId[c] !== r.id || grid[c] !== FLOOR || doorway[c]) continue;
        let solid = false;
        for (let oy = -1; oy <= 1 && !solid; oy++) for (let ox = -1; ox <= 1; ox++) if (grid[idx(x + ox, y + oy)] !== FLOOR) { solid = true; break; }
        if (!solid) { lake[c] = 1; lakeCells.push({ x, y }); }
      }
  }
  const arches: Arch[] = [];
  {
    const aseen = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = idx(x, y);
      if (!doorway[c] || aseen[c]) continue;
      let rx = 0;
      if (x < W - 1 && roomId[c + 1] >= 0) rx = 1;
      else if (x > 0 && roomId[c - 1] >= 0) rx = -1;
      const px = rx === 0 ? 1 : 0, py = rx === 0 ? 0 : 1;
      let x0 = x, y0 = y, x1 = x, y1 = y;
      while (inB(x0 - px, y0 - py) && doorway[idx(x0 - px, y0 - py)] && !aseen[idx(x0 - px, y0 - py)]) { x0 -= px; y0 -= py; }
      while (inB(x1 + px, y1 + py) && doorway[idx(x1 + px, y1 + py)] && !aseen[idx(x1 + px, y1 + py)]) { x1 += px; y1 += py; }
      let len = 0;
      for (let ax = x0, ay = y0; ; ax += px, ay += py) { aseen[idx(ax, ay)] = 1; len++; if (ax === x1 && ay === y1) break; }
      if (len <= 3) arches.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, px, py, len });
    }
  }

  // -- 6. flood fill from the entrance: distances, and every floor cell must be reached --
  const distance = new Int16Array(W * H).fill(-1);
  const ei = idx(rooms[entrance].cx, rooms[entrance].cy);
  const total = W * H;
  let floorTotal = 0;
  for (let i = 0; i < total; i++) if (grid[i] === FLOOR) floorTotal++;
  let reach = 0, maxDistance = 0;
  if (grid[ei] === FLOOR) {
    const q = new Int32Array(floorTotal);
    let qh = 0, qt = 0;
    q[qt++] = ei;
    distance[ei] = 0;
    reach = 1;
    while (qh < qt) {
      const c = q[qh++], x = c % W, b = distance[c] + 1;
      let n: number;
      if (x > 0 && grid[(n = c - 1)] === FLOOR && distance[n] < 0) { distance[n] = b; q[qt++] = n; reach++; }
      if (x < W - 1 && grid[(n = c + 1)] === FLOOR && distance[n] < 0) { distance[n] = b; q[qt++] = n; reach++; }
      if (c >= W && grid[(n = c - W)] === FLOOR && distance[n] < 0) { distance[n] = b; q[qt++] = n; reach++; }
      if (c < total - W && grid[(n = c + W)] === FLOOR && distance[n] < 0) { distance[n] = b; q[qt++] = n; reach++; }
    }
    maxDistance = distance[q[qt - 1]];
  }
  const valid = reach === floorTotal && floorTotal > 0;

  // -- 7. decorate: set pieces per room role, monster spawns, torches, debris --
  const props: Prop[] = [];
  const spawns: Spawn[] = [];
  const occ = new Uint8Array(W * H);
  const nearDoor = (x: number, y: number, d: number): boolean => {
    for (let oy = -d; oy <= d; oy++) for (let ox = -d; ox <= d; ox++) if (inB(x + ox, y + oy) && doorway[idx(x + ox, y + oy)]) return true;
    return false;
  };
  const interior = (x: number, y: number): boolean => {
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (!inB(x + ox, y + oy) || grid[idx(x + ox, y + oy)] !== FLOOR) return false;
    return true;
  };
  const put = (kind: string, x: number, y: number, rot: number, scale: number, room: number): void => {
    props.push({ kind, x, y, rot: rot || 0, scale: scale || 1, room });
    occ[idx(x, y)] = 1;
  };

  for (const r of rooms) {
    const cix = idx(r.cx, r.cy);
    if (r.type === "entrance") put("ring", r.cx, r.cy, 0, 1, r.id);
    if (r.type === "boss") {
      put("bossCrystal", r.cx, r.cy, rng.f(0, 6.28), 1, r.id);
      const rr = Math.max(2.5, Math.min(r.w, r.h) / 2 - 2), a0 = rng.f(0, 1);
      for (let k = 0; k < 6; k++) {
        const a = a0 + (k * Math.PI) / 3;
        const bx = Math.round(r.cx + Math.cos(a) * rr), by = Math.round(r.cy + Math.sin(a) * rr);
        if (inB(bx, by) && grid[idx(bx, by)] === FLOOR && !occ[idx(bx, by)] && !nearDoor(bx, by, 1)) put("brazier", bx, by, 0, 1, r.id);
      }
    }
    if (r.type === "treasure" && grid[cix] === FLOOR) put("chest", r.cx, r.cy, (rng.i(0, 3) * Math.PI) / 2, 1, r.id);
    if (r.type === "shrine" && grid[cix] === FLOOR) put("shrineCrystal", r.cx, r.cy, rng.f(0, 6.28), 1, r.id);

    if ((r.type === "combat" || r.type === "elite") && Math.min(r.w, r.h) >= 10 && r.shape !== "ellipse" && !r.grave && !r.lake) {
      const step = Math.min(r.w, r.h) >= 14 ? 4 : 3;
      for (let y = Math.ceil(r.cy - r.h / 2) + 2; y <= r.cy + r.h / 2 - 2; y++)
        for (let x = Math.ceil(r.cx - r.w / 2) + 2; x <= r.cx + r.w / 2 - 2; x++) {
          if ((x - r.cx) % step !== 0 || (y - r.cy) % step !== 0) continue;
          if (x === r.cx && y === r.cy) continue;
          if (interior(x, y) && !occ[idx(x, y)] && !nearDoor(x, y, 2)) put("pillar", x, y, 0, rng.f(0.94, 1.06), r.id);
        }
    }
    if (r.grave) {
      for (let y = Math.ceil(r.cy - r.h / 2) + 2; y <= r.cy + r.h / 2 - 2; y += 2)
        for (let x = Math.ceil(r.cx - r.w / 2) + 2; x <= r.cx + r.w / 2 - 2; x += 2) {
          if (Math.abs(x - r.cx) <= 1 && Math.abs(y - r.cy) <= 1) continue;
          if (interior(x, y) && !occ[idx(x, y)] && !nearDoor(x, y, 2) && rng.chance(0.8)) put("grave", x, y, rng.f(-0.3, 0.3), rng.f(0.85, 1.15), r.id);
        }
      if (Math.min(r.w, r.h) >= 10 && grid[cix] === FLOOR && !occ[cix]) put("sarcophagus", r.cx, r.cy, rng.chance(0.5) ? 0 : Math.PI / 2, 1, r.id);
      let cd = 4;
      while (cd-- > 0) {
        const x = rng.i(Math.floor(r.cx - r.w / 2) + 1, Math.ceil(r.cx + r.w / 2) - 1);
        const y = rng.i(Math.floor(r.cy - r.h / 2) + 1, Math.ceil(r.cy + r.h / 2) - 1);
        if (inB(x, y) && roomId[idx(x, y)] === r.id && grid[idx(x, y)] === FLOOR && !occ[idx(x, y)]) put("candle", x, y, 0, rng.f(0.85, 1.2), r.id);
      }
    }
    if (r.type === "combat" || r.type === "elite" || r.type === "boss") {
      let area = 0;
      for (let y = Math.floor(r.cy - r.h / 2); y <= Math.ceil(r.cy + r.h / 2); y++)
        for (let x = Math.floor(r.cx - r.w / 2); x <= Math.ceil(r.cx + r.w / 2); x++) if (inB(x, y) && roomId[idx(x, y)] === r.id) area++;
      let count = Math.round((area / 18) * (0.5 + r.difficulty));
      if (r.type === "elite") count = Math.max(2, Math.round(count * 0.6));
      if (r.type === "boss") count = rng.i(2, 3);
      const tier = r.type === "elite" ? 3 : Math.max(1, Math.ceil(r.difficulty * 3));
      let guard = 0;
      while (count > 0 && guard++ < 220) {
        const x = rng.i(Math.floor(r.cx - r.w / 2) + 1, Math.ceil(r.cx + r.w / 2) - 1);
        const y = rng.i(Math.floor(r.cy - r.h / 2) + 1, Math.ceil(r.cy + r.h / 2) - 1);
        if (!inB(x, y)) continue;
        const c = idx(x, y);
        if (roomId[c] === r.id && grid[c] === FLOOR && !occ[c] && !doorway[c] && !lake[c]) { spawns.push({ x, y, tier, room: r.id }); occ[c] = 1; count--; }
      }
    }
  }
  const torchCand: Torch[] = [];
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const c = row + x;
      if (grid[c] !== WALL) continue;
      if (x < W - 1 && grid[c + 1] === FLOOR) torchCand.push({ x, y, dx: 1, dy: 0 });
      else if (x > 0 && grid[c - 1] === FLOOR) torchCand.push({ x, y, dx: -1, dy: 0 });
      else if (y < H - 1 && grid[c + W] === FLOOR) torchCand.push({ x, y, dx: 0, dy: 1 });
      else if (y > 0 && grid[c - W] === FLOOR) torchCand.push({ x, y, dx: 0, dy: -1 });
    }
  }
  shuffle(rng, torchCand);
  const torches: Torch[] = [];
  for (const c of torchCand) {
    let ok = true;
    for (const t of torches) if (Math.max(Math.abs(t.x - c.x), Math.abs(t.y - c.y)) < 4) { ok = false; break; }
    if (ok) torches.push(c);
  }
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const c = row + x;
      if (grid[c] !== FLOOR || occ[c] || doorway[c] || lake[c]) continue;
      const rid = roomId[c];
      const diff = rid >= 0 ? rooms[rid].difficulty : 0.5;
      let p = params.decorDensity * 0.045 * (1.25 - 0.6 * diff);
      if (corridor[c]) p *= 0.45;
      if (rng.chance(p)) props.push({ kind: "debris", x, y, rot: rng.f(0, 6.28), scale: rng.f(0.6, 1.35), room: rid, variant: rng.i(0, 2) });
    }
  }

  // -- 7.5 theme dressing: icicles, roots and moss, bones, cracks, banners --
  const floorDir = (x: number, y: number): [number, number] | null => {
    const c = idx(x, y);
    if (x < W - 1 && grid[c + 1] === FLOOR) return [1, 0];
    if (x > 0 && grid[c - 1] === FLOOR) return [-1, 0];
    if (y < H - 1 && grid[c + W] === FLOOR) return [0, 1];
    if (y > 0 && grid[c - W] === FLOOR) return [0, -1];
    return null;
  };
  if (TH.icicles) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (grid[idx(x, y)] !== WALL) continue;
      const d = floorDir(x, y);
      if (d && rng.chance(0.06 + 0.08 * params.decorDensity)) props.push({ kind: "icicle", x, y, dx: d[0], dy: d[1], rot: rng.f(0, 6.28), scale: rng.f(0.7, 1.3) });
    }
    for (const lc of lakeCells) if (rng.chance(0.05)) props.push({ kind: "iceShard", x: lc.x, y: lc.y, rot: rng.f(0, 6.28), scale: rng.f(0.6, 1.2) });
  }
  if (TH.roots) {
    const sites: Torch[] = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      if (grid[idx(x, y)] !== WALL) continue;
      const d = floorDir(x, y);
      if (d && roomId[idx(x + d[0], y + d[1])] >= 0) sites.push({ x, y, dx: d[0], dy: d[1] });
    }
    shuffle(rng, sites);
    const breaches: Torch[] = [];
    for (const s of sites) {
      if (breaches.length >= 5) break;
      let close = false;
      for (const b of breaches) if (Math.max(Math.abs(b.x - s.x), Math.abs(b.y - s.y)) < 7) { close = true; break; }
      if (!close) breaches.push(s);
    }
    const mossMask = new Uint8Array(W * H);
    for (const b of breaches) {
      props.push({ kind: "roots", x: b.x, y: b.y, dx: b.dx, dy: b.dy, rot: 0, scale: rng.f(0.9, 1.2) });
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
        const nx = b.x + ox, ny = b.y + oy;
        if (!inB(nx, ny)) continue;
        const c = idx(nx, ny);
        if (grid[c] === FLOOR && !mossMask[c] && rng.chance(0.75)) { mossMask[c] = 1; props.push({ kind: "moss", x: nx, y: ny, rot: rng.f(0, 6.28), scale: rng.f(0.7, 1.4) }); }
      }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = idx(x, y);
      if (grid[c] !== FLOOR || mossMask[c] || lake[c]) continue;
      let nw = 0;
      if (x < W - 1 && grid[c + 1] === WALL) nw++;
      if (x > 0 && grid[c - 1] === WALL) nw++;
      if (y < H - 1 && grid[c + W] === WALL) nw++;
      if (y > 0 && grid[c - W] === WALL) nw++;
      if (nw > 0 && rng.chance(0.12 * params.decorDensity)) { mossMask[c] = 1; props.push({ kind: "moss", x, y, rot: rng.f(0, 6.28), scale: rng.f(0.6, 1.3) }); }
    }
  }
  if (TH.bones) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = idx(x, y);
      if (grid[c] !== FLOOR || occ[c] || doorway[c] || corridor[c]) continue;
      const rid = roomId[c];
      if (rid >= 0 && rooms[rid].depth > 1 && rng.chance(0.018 + 0.02 * params.decorDensity)) props.push({ kind: "bones", x, y, rot: rng.f(0, 6.28), scale: rng.f(0.8, 1.2), room: rid });
    }
  }
  {
    // Cracks radiate from the liquid into the stone (and around frozen lakes).
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    if (TH.pools && (TH.pools.mode === 0 || TH.pools.mode === 3)) {
      const pv = TH.pools.mode === 0 ? 0.8 : 0.45;
      for (const p of pools)
        for (const [dx, dy] of DIRS) {
          const nx = p.x + dx, ny = p.y + dy;
          if (!inB(nx, ny) || grid[idx(nx, ny)] !== FLOOR) continue;
          if (rng.chance(pv)) props.push({ kind: "crack", x: nx, y: ny, dx, dy, rot: rng.f(0, 6.28), scale: rng.f(0.9, 1.5) });
        }
    }
    if (TH.lakes) {
      for (const lc of lakeCells)
        for (const [dx, dy] of DIRS) {
          const nx = lc.x + dx, ny = lc.y + dy;
          if (!inB(nx, ny)) continue;
          const c2 = idx(nx, ny);
          if (grid[c2] !== FLOOR || lake[c2]) continue;
          if (rng.chance(0.3)) props.push({ kind: "crack", x: nx, y: ny, dx, dy, rot: rng.f(0, 6.28), scale: rng.f(0.7, 1.2), ice: true });
        }
    }
  }
  for (const r of rooms) {
    if (r.type !== "elite" && r.type !== "boss") continue;
    const cand: Torch[] = [];
    for (let y = Math.floor(r.cy - r.h / 2) - 1; y <= Math.ceil(r.cy + r.h / 2) + 1; y++)
      for (let x = Math.floor(r.cx - r.w / 2) - 1; x <= Math.ceil(r.cx + r.w / 2) + 1; x++) {
        if (!inB(x, y) || grid[idx(x, y)] !== WALL) continue;
        const d = floorDir(x, y);
        if (d && roomId[idx(x + d[0], y + d[1])] === r.id) cand.push({ x, y, dx: d[0], dy: d[1] });
      }
    shuffle(rng, cand);
    const placed: Torch[] = [];
    for (const s of cand) {
      if (placed.length >= (r.type === "boss" ? 4 : 2)) break;
      let close = false;
      for (const p of placed) if (Math.max(Math.abs(p.x - s.x), Math.abs(p.y - s.y)) < 4) { close = true; break; }
      if (!close) { placed.push(s); props.push({ kind: "banner", x: s.x, y: s.y, dx: s.dx, dy: s.dy, rot: 0, scale: 1 }); }
    }
  }

  const loops = edges.filter((e) => e.loop).length;
  return {
    params, seed, attempts: 1, valid, name: dungeonName(rng, TH),
    width: W, height: H, grid, roomId, corridor, doorway, lake, distance, maxDistance,
    rooms, corridors: edges, entrance, boss, maxDepth,
    props, spawns, torches, pools, arches,
    stats: { rooms: N, corridors: edges.length, loops, criticalPath: critLen, floorTiles: floorTotal },
  };
}

function invalid(params: DungeonParams, seed: number): Dungeon {
  const empty = new Uint8Array(0);
  return {
    params, seed, attempts: 1, valid: false, name: "", width: 0, height: 0,
    grid: empty, roomId: new Int16Array(0), corridor: empty, doorway: empty, lake: empty, distance: new Int16Array(0), maxDistance: 0,
    rooms: [], corridors: [], entrance: -1, boss: -1, maxDepth: 0, props: [], spawns: [], torches: [], pools: [], arches: [],
    stats: { rooms: 0, corridors: 0, loops: 0, criticalPath: 0, floorTiles: 0 },
  };
}
