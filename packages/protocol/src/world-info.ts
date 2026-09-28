/**
 * World info — what a client learns about a baked world when it joins
 * (welcome.world): the chunk range, and a coarse map of the whole world
 * (elevation, biome, rivers) for the far horizon and ground colours. The
 * live terrain near the player still streams as chunk tiles.
 *
 * The map travels inside the JSON welcome, so its arrays are base64:
 * heights as u16 over [minHeight, maxHeight] (~0.5 cm steps over a 300 m
 * range), biome and river as u8, and the water surface (sea and lakes) as
 * u16 over the same range with 0xffff for dry ground. Browser- and
 * Node-safe (atob/btoa).
 */

/** Inclusive chunk range. */
export interface ChunkRange {
  minCx: number;
  minCz: number;
  maxCx: number;
  maxCz: number;
}

/** A coarse whole-world map as sent: cell (u, v) at world (originX + u*cell, originZ + v*cell), row-major, u inner. */
export interface WorldMapWire {
  cell: number;
  width: number;
  depth: number;
  originX: number;
  originZ: number;
  heights: string;
  minHeight: number;
  maxHeight: number;
  biome: string;
  /** Biome ids; biome map values index this list. */
  biomes: string[];
  river: string;
  /** Water surface height per cell (absent: worlds from before water was sent). */
  water?: string;
}

export interface WorldInfo {
  name: string;
  chunkWorldSize: number;
  bounds: ChunkRange;
  map: WorldMapWire;
  /** Sea level, metres (absent: a world without a sea level on record). */
  seaLevel?: number;
}

/** A decoded world map. */
export interface WorldMap {
  cell: number;
  width: number;
  depth: number;
  originX: number;
  originZ: number;
  heights: Float32Array;
  biome: Uint8Array;
  biomes: string[];
  river: Uint8Array;
  /** Water surface height per cell (sea or lake), NaN on dry ground; absent if not sent. */
  water?: Float32Array;
}

/** Water layer value for dry ground. */
const DRY = 0xffff;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  // Chunked: String.fromCharCode(...bigArray) overflows the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encodeWorldMap(map: WorldMap): WorldMapWire {
  const n = map.width * map.depth;
  if (map.heights.length !== n || map.biome.length !== n || map.river.length !== n) {
    throw new Error(`world map: every layer needs ${map.width}x${map.depth} cells`);
  }
  if (map.water && map.water.length !== n) throw new Error(`world map: every layer needs ${map.width}x${map.depth} cells`);
  let min = Infinity;
  let max = -Infinity;
  for (const h of map.heights) {
    if (h < min) min = h;
    if (h > max) max = h;
  }
  // Water surfaces share the range (a lake can sit above every mean height).
  for (const w of map.water ?? []) {
    if (Number.isNaN(w)) continue;
    if (w < min) min = w;
    if (w > max) max = w;
  }
  const span = max > min ? max - min : 1;
  const q = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(((map.heights[i] - min) / span) * 65535);
    q[2 * i] = v & 0xff;
    q[2 * i + 1] = v >> 8;
  }
  let water: string | undefined;
  if (map.water) {
    const w = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      const v = Number.isNaN(map.water[i]) ? DRY : Math.min(DRY - 1, Math.round(((map.water[i] - min) / span) * 65535));
      w[2 * i] = v & 0xff;
      w[2 * i + 1] = v >> 8;
    }
    water = toBase64(w);
  }
  return {
    cell: map.cell,
    width: map.width,
    depth: map.depth,
    originX: map.originX,
    originZ: map.originZ,
    heights: toBase64(q),
    minHeight: min,
    maxHeight: max,
    biome: toBase64(map.biome),
    biomes: map.biomes,
    river: toBase64(map.river),
    ...(water !== undefined ? { water } : {}),
  };
}

export function decodeWorldMap(wire: WorldMapWire): WorldMap {
  const n = wire.width * wire.depth;
  const q = fromBase64(wire.heights);
  const biome = fromBase64(wire.biome);
  const river = fromBase64(wire.river);
  if (q.length !== 2 * n || biome.length !== n || river.length !== n) {
    throw new Error(`world map: layers don't match ${wire.width}x${wire.depth} cells`);
  }
  const span = wire.maxHeight > wire.minHeight ? wire.maxHeight - wire.minHeight : 1;
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) heights[i] = wire.minHeight + ((q[2 * i] | (q[2 * i + 1] << 8)) / 65535) * span;
  let water: Float32Array | undefined;
  if (wire.water !== undefined) {
    const w = fromBase64(wire.water);
    if (w.length !== 2 * n) throw new Error(`world map: layers don't match ${wire.width}x${wire.depth} cells`);
    water = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = w[2 * i] | (w[2 * i + 1] << 8);
      water[i] = v === DRY ? Number.NaN : wire.minHeight + (v / 65535) * span;
    }
  }
  return {
    cell: wire.cell,
    width: wire.width,
    depth: wire.depth,
    originX: wire.originX,
    originZ: wire.originZ,
    heights,
    biome,
    biomes: wire.biomes,
    river,
    ...(water !== undefined ? { water } : {}),
  };
}
