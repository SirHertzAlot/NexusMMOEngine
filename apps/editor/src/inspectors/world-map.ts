/**
 * World map overview (ROADMAP E9, OPEN-WORLD-PLAN.md Phase 4) — the whole
 * baked world at the welcome's ~16 m resolution, for the Terrain tab:
 * where the loaded area is, where the camera is, the region grid, and a
 * click to jump. Pure TS (no DOM, no three.js), so the redesign can draw
 * it however it likes.
 *
 * The picture is the client's ground colour per biome (passed in, so this
 * module doesn't import the renderer), lit by a hillshade from the
 * heights, with water drawn over it at its surface.
 */

import type { WorldMap } from "@mmo-engine/protocol";

/** Inclusive chunk rectangle [cx0, cz0, cx1, cz1]. */
export type ChunkRange = [number, number, number, number];

export interface WorldRegion {
  rx: number;
  rz: number;
  range: ChunkRange;
}

export interface AreaRef {
  cx: number;
  cz: number;
  radius: number;
}

const SEA = [38, 86, 128] as const;
const LAKE = [56, 112, 150] as const;

/**
 * RGBA pixels, one per map cell (row-major, north up as the map is):
 * `ground` colours (RGBA per cell) lit from the north-west, water over it.
 */
export function shadeMap(map: WorldMap, ground: Uint8Array, seaLevel?: number): Uint8ClampedArray {
  const { width: w, depth: d, heights: h, cell } = map;
  const out = new Uint8ClampedArray(w * d * 4);
  const at = (u: number, v: number): number => h[Math.min(d - 1, Math.max(0, v)) * w + Math.min(w - 1, Math.max(0, u))];
  for (let v = 0; v < d; v++) {
    for (let u = 0; u < w; u++) {
      const i = v * w + u;
      // Slope toward the light (north-west): 1 flat, brighter facing it.
      const dx = (at(u + 1, v) - at(u - 1, v)) / (2 * cell);
      const dz = (at(u, v + 1) - at(u, v - 1)) / (2 * cell);
      const light = Math.min(1.5, Math.max(0.45, 1 - (dx + dz) * 1.6));
      let r = ground[4 * i] * light;
      let g = ground[4 * i + 1] * light;
      let b = ground[4 * i + 2] * light;
      const water = map.water?.[i];
      if (water !== undefined && !Number.isNaN(water) && water > h[i]) {
        const c = seaLevel !== undefined && Math.abs(water - seaLevel) < 1e-3 ? SEA : LAKE;
        // Deeper water is darker; the shallows show the bed through.
        const t = Math.min(1, 0.55 + (water - h[i]) / 40);
        r = r + (c[0] - r) * t;
        g = g + (c[1] - g) * t;
        b = b + (c[2] - b) * t;
      }
      out[4 * i] = r;
      out[4 * i + 1] = g;
      out[4 * i + 2] = b;
      out[4 * i + 3] = 255;
    }
  }
  return out;
}

/** World metres → map pixel (fractional). */
export function worldToMap(map: Pick<WorldMap, "cell" | "originX" | "originZ">, x: number, z: number): { u: number; v: number } {
  return { u: (x - map.originX) / map.cell, v: (z - map.originZ) / map.cell };
}

/** Map pixel → world metres. */
export function mapToWorld(map: Pick<WorldMap, "cell" | "originX" | "originZ">, u: number, v: number): { x: number; z: number } {
  return { x: map.originX + u * map.cell, z: map.originZ + v * map.cell };
}

/** The chunk a world point is in. */
export function chunkAt(x: number, z: number, chunkWorldSize: number): { cx: number; cz: number } {
  return { cx: Math.floor(x / chunkWorldSize), cz: Math.floor(z / chunkWorldSize) };
}

/** A chunk range in world metres: [x0, z0, x1, z1) . */
export function rangeMetres(range: ChunkRange, chunkWorldSize: number): [number, number, number, number] {
  return [range[0] * chunkWorldSize, range[1] * chunkWorldSize, (range[2] + 1) * chunkWorldSize, (range[3] + 1) * chunkWorldSize];
}

export function areaRange(a: AreaRef): ChunkRange {
  return [a.cx - a.radius, a.cz - a.radius, a.cx + a.radius, a.cz + a.radius];
}

/** An area centred on (cx, cz), kept inside the world's chunk range. */
export function areaAround(cx: number, cz: number, radius: number, bounds: { minChunk: number; maxChunk: number }): AreaRef {
  const lo = bounds.minChunk + radius;
  const hi = bounds.maxChunk - radius;
  const clamp = (c: number): number => (lo > hi ? Math.round((bounds.minChunk + bounds.maxChunk) / 2) : Math.min(hi, Math.max(lo, c)));
  return { cx: clamp(cx), cz: clamp(cz), radius };
}

/**
 * Streaming the area round the camera: the area to load next when the
 * camera's target has wandered more than half the area's radius from its
 * centre (null: stay). Never while there are unsaved edits — loading
 * another area would drop them.
 */
export function followCamera(
  area: AreaRef,
  target: { x: number; z: number },
  chunkWorldSize: number,
  bounds: { minChunk: number; maxChunk: number },
  dirty: boolean,
): AreaRef | null {
  if (dirty) return null;
  const { cx, cz } = chunkAt(target.x, target.z, chunkWorldSize);
  const off = Math.max(Math.abs(cx - area.cx), Math.abs(cz - area.cz));
  if (off <= Math.max(1, Math.floor(area.radius / 2))) return null;
  const next = areaAround(cx, cz, area.radius, bounds);
  return next.cx === area.cx && next.cz === area.cz ? null : next;
}

/** The region holding a chunk, if the world has a region grid. */
export function regionAt(regions: readonly WorldRegion[], cx: number, cz: number): WorldRegion | null {
  return regions.find((r) => cx >= r.range[0] && cx <= r.range[2] && cz >= r.range[1] && cz <= r.range[3]) ?? null;
}

/** What the map says about the cell under a world point. */
export function describeAt(map: WorldMap, x: number, z: number): { biome: string; height: number; river: boolean } | null {
  const { u, v } = worldToMap(map, x, z);
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  if (iu < 0 || iv < 0 || iu >= map.width || iv >= map.depth) return null;
  const i = iv * map.width + iu;
  return { biome: map.biomes[map.biome[i]] ?? "?", height: map.heights[i], river: map.river[i] > 0 };
}

// ---- brush ------------------------------------------------------------------

/** Brush radius slider position 0..1 ↔ metres, 1 m to 256 m (mountain scale) on a log scale. */
export const BRUSH_MIN = 1;
export const BRUSH_MAX = 256;
export function brushRadius(t: number): number {
  const r = BRUSH_MIN * Math.pow(BRUSH_MAX / BRUSH_MIN, Math.min(1, Math.max(0, t)));
  return r < 10 ? Math.round(r * 2) / 2 : Math.round(r);
}
export function brushSlider(radius: number): number {
  return Math.log(Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, radius)) / BRUSH_MIN) / Math.log(BRUSH_MAX / BRUSH_MIN);
}
