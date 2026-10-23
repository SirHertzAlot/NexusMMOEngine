/**
 * Core data model for threat-driven fortification (bake-time).
 *
 * A settlement is a tile grid plus structures: a wall ring, a gate, a core
 * (keep / hall), towers, and whatever the fortify loop adds (barbican, moat,
 * approach islands). Terrain carries the two facts the attack sim needs:
 * surface movement cost (derived from `terrain`) and, for mining, whether
 * the soil can be tunnelled and how far down the water table sits — the
 * hydrology query "will a sap tunnel flood here?" in baked form.
 */

export type TerrainKind = "water" | "marsh" | "land" | "road";

export interface Tile {
  terrain: TerrainKind;
  /** Soil can be tunnelled (rock / flooded ground cannot). */
  diggable: boolean;
  /** Metres below the surface to the water table. A sap tunnel runs ~2 m
   *  deep: if `waterDepth <= TUNNEL_DEPTH` the tunnel floods. */
  waterDepth: number;
}

/** Depth of a typical sap (mining) tunnel, metres. */
export const TUNNEL_DEPTH = 2;

export interface Grid {
  w: number;
  h: number;
  /** Row-major tiles, index = y * w + x. */
  tiles: Tile[];
}

export const idx = (g: Grid, x: number, y: number): number => y * g.w + x;
export const tx = (g: Grid, i: number): number => i % g.w;
export const ty = (g: Grid, i: number): number => Math.floor(i / g.w);
export const inBounds = (g: Grid, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < g.w && y < g.h;

/** 4-neighbour indices of a tile. */
export function neighbours4(g: Grid, i: number): number[] {
  const x = tx(g, i);
  const y = ty(g, i);
  const out: number[] = [];
  if (x > 0) out.push(i - 1);
  if (x < g.w - 1) out.push(i + 1);
  if (y > 0) out.push(i - g.w);
  if (y < g.h - 1) out.push(i + g.w);
  return out;
}

export type TowerForm = "square" | "round";

export interface Tower {
  x: number;
  y: number;
  form: TowerForm;
}

/** A wall face: a maximal run of wall tiles on one side of the ring. */
export type FaceId = "north" | "south" | "east" | "west";

export interface Settlement {
  name: string;
  grid: Grid;
  /** Wall tiles (the gate tile is included and also named by `gate`). */
  walls: Set<number>;
  /** The gate tile: the approach's target. */
  gate: number;
  /** The core tile (keep / hall): what the defence ultimately protects. */
  core: number;
  towers: Tower[];
  /** Outer gatehouse island tile, once a barbican is built. */
  barbican: number | null;
  /** Tiles flooded as moat by the fortify loop. */
  moat: Set<number>;
  /** Island tiles inserted into the approach to force a bend. */
  islands: Set<number>;
}

/** Deep-enough copy for the fortify loop to mutate freely. */
export function cloneSettlement(s: Settlement): Settlement {
  return {
    name: s.name,
    grid: {
      w: s.grid.w,
      h: s.grid.h,
      tiles: s.grid.tiles.map((t) => ({ ...t })),
    },
    walls: new Set(s.walls),
    gate: s.gate,
    core: s.core,
    towers: s.towers.map((t) => ({ ...t })),
    barbican: s.barbican,
    moat: new Set(s.moat),
    islands: new Set(s.islands),
  };
}

/** Deterministic seeded RNG (mulberry32): same seed, same stream, always. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
