/**
 * The world info clients get in their welcome (see @mmo-engine/protocol
 * world-info): a baked world's chunk range and a coarse whole-world map,
 * built from the survey maps the bake stored in world.db.
 *
 * The survey is 8 m; clients get it at ~16 m (a 4 km world: 254 x 254
 * cells, ~340 KB of base64), which is plenty for terrain seen from far
 * away and for ground colours that blend over tens of metres.
 *
 * The water surface (sea and lakes) goes too, reaching one cell past the
 * shore: clients draw it as a flat sheet per cell and the ground hides
 * what lies under the land, so the shoreline is the terrain's own.
 */

import { encodeWorldMap, type WorldInfo } from "@mmo-engine/protocol";
import type { TerrainTileStore, WorldMap as StoredMap } from "../persist/terrain-tiles.js";
import { SEA } from "./hydrology.js";

export interface WorldInfoMeta {
  getMeta(key: string): string | null;
}

/** Target cell size of the map sent to clients, metres. */
const CLIENT_CELL = 16;

/**
 * Average (heights), take the maximum (rivers), or take the centre sample
 * (biome ids) over k x k blocks of a stored survey map.
 */
function downsample(map: StoredMap, k: number, mode: "mean" | "max" | "centre"): { width: number; depth: number; data: Float32Array } {
  const width = Math.floor(map.width / k);
  const depth = Math.floor(map.depth / k);
  const data = new Float32Array(width * depth);
  for (let v = 0; v < depth; v++) {
    for (let u = 0; u < width; u++) {
      let acc = mode === "max" ? -Infinity : 0;
      if (mode === "centre") {
        acc = map.data[(v * k + (k >> 1)) * map.width + u * k + (k >> 1)];
      } else {
        for (let dv = 0; dv < k; dv++) {
          for (let du = 0; du < k; du++) {
            const x = map.data[(v * k + dv) * map.width + u * k + du];
            acc = mode === "max" ? Math.max(acc, x) : acc + x;
          }
        }
        if (mode === "mean") acc /= k * k;
      }
      data[v * width + u] = acc;
    }
  }
  return { width, depth, data };
}

/**
 * Water surface per k x k block. The sea: any block touching it, at sea
 * level, then one block wider onto the shore (clients draw it as flat
 * sheets and the ground hides what lies under the land). Lakes: blocks
 * mostly under one, at its surface, never widened: a lake can sit up in
 * a crater or behind a moraine, and a sheet reaching past the rim would
 * hang in the air. `level` is the stored water_level map (lake surfaces);
 * worlds baked before it get the sea only.
 */
export function downsampleWater(
  maps: { level: StoredMap | null; water: StoredMap },
  seaLevel: number,
  k: number,
): Float32Array {
  const { water, level } = maps;
  const width = Math.floor(water.width / k);
  const depth = Math.floor(water.depth / k);
  const out = new Float32Array(width * depth).fill(Number.NaN);
  const sea = new Uint8Array(width * depth);
  for (let v = 0; v < depth; v++) {
    for (let u = 0; u < width; u++) {
      let lakeCells = 0;
      let lake = Number.NaN;
      for (let dv = 0; dv < k; dv++) {
        for (let du = 0; du < k; du++) {
          const i = (v * k + dv) * water.width + u * k + du;
          if (water.data[i] === SEA) {
            sea[v * width + u] = 1;
          } else if (level && !Number.isNaN(level.data[i])) {
            lakeCells++;
            if (Number.isNaN(lake) || level.data[i] > lake) lake = level.data[i];
          }
        }
      }
      if (sea[v * width + u]) out[v * width + u] = seaLevel;
      else if (2 * lakeCells >= k * k) out[v * width + u] = lake;
    }
  }
  for (let v = 0; v < depth; v++) {
    for (let u = 0; u < width; u++) {
      if (!Number.isNaN(out[v * width + u])) continue;
      let shore = false;
      for (let dv = -1; dv <= 1 && !shore; dv++) {
        for (let du = -1; du <= 1; du++) {
          const uu = u + du;
          const vv = v + dv;
          if (uu >= 0 && vv >= 0 && uu < width && vv < depth && sea[vv * width + uu]) {
            shore = true;
            break;
          }
        }
      }
      if (shore) out[v * width + u] = seaLevel;
    }
  }
  return out;
}

/** World info for a baked world, or null for a legacy world (no survey maps). */
export function worldInfoFor(meta: WorldInfoMeta, tiles: TerrainTileStore, chunkWorldSize: number): WorldInfo | null {
  const bounds = meta.getMeta("world_bounds");
  const elevation = tiles.getMap("elevation");
  const biome = tiles.getMap("biome");
  const river = tiles.getMap("river");
  if (!bounds || !elevation || !biome || !river) return null;
  const { minChunk, maxChunk } = JSON.parse(bounds) as { minChunk: number; maxChunk: number };
  const k = Math.max(1, Math.round(CLIENT_CELL / elevation.cell));
  // Mean heights over a block sit at the block's centre, not its corner.
  const centreShift = ((k - 1) / 2) * elevation.cell;
  const h = downsample(elevation, k, "mean");
  const b = downsample(biome, k, "centre");
  const r = downsample(river, k, "max");
  const biomeIds = meta.getMeta("world_biomes");
  const seaLevelMeta = meta.getMeta("sea_level");
  const seaLevel = seaLevelMeta === null ? null : Number(seaLevelMeta);
  const waterMap = tiles.getMap("water");
  const water =
    seaLevel !== null && waterMap
      ? downsampleWater({ level: tiles.getMap("water_level"), water: waterMap }, seaLevel, k)
      : undefined;
  return {
    name: meta.getMeta("world_spec") ?? "world",
    chunkWorldSize,
    bounds: { minCx: minChunk, minCz: minChunk, maxCx: maxChunk, maxCz: maxChunk },
    map: encodeWorldMap({
      cell: elevation.cell * k,
      width: h.width,
      depth: h.depth,
      originX: elevation.originX + centreShift,
      originZ: elevation.originZ + centreShift,
      heights: h.data,
      biome: Uint8Array.from(b.data),
      biomes: biomeIds ? (JSON.parse(biomeIds) as string[]) : [],
      river: Uint8Array.from(r.data),
      ...(water ? { water } : {}),
    }),
    ...(seaLevel !== null ? { seaLevel } : {}),
  };
}
