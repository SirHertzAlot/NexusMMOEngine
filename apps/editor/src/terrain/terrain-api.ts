/**
 * Terrain panel <-> editor host (/api/editor/terrain*). Tiles travel as
 * plain number arrays; float32 values round-trip exactly through JSON.
 */

import { decodeWorldMap, type TerrainTile, type WorldInfo, type WorldMap } from "@mmo-engine/protocol";
import type { WorldRegion } from "../inspectors/world-map.js";

/** An area of the world, in chunks: (2*radius+1)^2 chunks around (cx, cz). */
export interface TerrainArea {
  cx: number;
  cz: number;
  radius: number;
}

export interface WorldTerrain {
  dataDir: string;
  chunkWorldSize: number;
  seed: string;
  /** False when the world has no stored tiles yet (shown as generated). */
  stored: boolean;
  amplitude: number;
  frequency: number;
  /** A world baked from a world spec (its chunk range); null for a legacy world. */
  world: { name: string; minChunk: number; maxChunk: number } | null;
  area: TerrainArea;
  /** Stored tiles in the whole world. */
  totalTiles: number;
  /** More stored tiles exist outside this area (its border is pinned). */
  partial: boolean;
  tiles: TerrainTile[];
  props: Array<[number, number, number]>;
}

export interface SaveResult {
  saved: number;
  changed: Array<[number, number]>;
  reseatedProps: number;
  stoppedPlayMode: boolean;
}

interface WireTile {
  cx: number;
  cz: number;
  heights: number[];
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined
    ? undefined
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `${url} failed (${res.status})`);
  return json;
}

const fromWire = (t: WireTile): TerrainTile => ({ cx: t.cx, cz: t.cz, heights: Float32Array.from(t.heights) });
const toWire = (t: TerrainTile): WireTile => ({ cx: t.cx, cz: t.cz, heights: Array.from(t.heights) });

/** Load one area of the world (default: around (0,0)). */
export async function loadTerrain(area?: TerrainArea): Promise<WorldTerrain> {
  const json = await call<Omit<WorldTerrain, "tiles"> & { tiles: WireTile[] }>(
    area ? "/api/editor/terrain/area" : "/api/editor/terrain",
    area,
  );
  return { ...json, tiles: json.tiles.map(fromWire) };
}

export async function generateTerrain(
  req: { amplitude: number; frequency: number; chunks: Array<[number, number]> },
): Promise<TerrainTile[]> {
  const json = await call<{ tiles: WireTile[] }>("/api/editor/terrain/generate", req);
  return json.tiles.map(fromWire);
}

export async function saveTerrain(tiles: TerrainTile[]): Promise<SaveResult> {
  return call<SaveResult>("/api/editor/terrain", { tiles: tiles.map(toWire) });
}

/** The whole-world overview of a baked world; null for a legacy world. */
export interface WorldOverview {
  name: string;
  chunkWorldSize: number;
  bounds: { minChunk: number; maxChunk: number };
  map: WorldMap;
  seaLevel?: number;
  spawn: { x: number; z: number } | null;
  regions: WorldRegion[];
  /** Why regenerating isn't possible (null: it is). */
  regenerate: string | null;
}

export async function loadWorldOverview(): Promise<WorldOverview | null> {
  const json = await call<{ info: WorldInfo | null; spawn?: { x: number; z: number } | null; regions?: WorldRegion[]; regenerate?: string | null }>(
    "/api/editor/terrain/map",
  );
  if (!json.info) return null;
  const { info } = json;
  return {
    name: info.name,
    chunkWorldSize: info.chunkWorldSize,
    bounds: { minChunk: info.bounds.minCx, maxChunk: info.bounds.maxCx },
    map: decodeWorldMap(info.map),
    ...(info.seaLevel !== undefined ? { seaLevel: info.seaLevel } : {}),
    spawn: json.spawn ?? null,
    regions: json.regions ?? [],
    regenerate: json.regenerate ?? null,
  };
}

export interface RegenerateResult {
  range: [number, number, number, number];
  chunks: number;
  changed: number;
  reseatedProps: number;
  surveyMs: number;
  stoppedPlayMode: boolean;
}

/** Re-bake one region or area from the world spec (see terrain-tool regenerate). */
export async function regenerateTerrain(req: { region: [number, number] } | { area: TerrainArea }): Promise<RegenerateResult> {
  return call<RegenerateResult>("/api/editor/terrain/regenerate", req);
}
