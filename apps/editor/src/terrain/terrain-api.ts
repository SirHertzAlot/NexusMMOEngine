/**
 * Terrain panel <-> editor host (/api/editor/terrain*). Tiles travel as
 * plain number arrays; float32 values round-trip exactly through JSON.
 */

import type { TerrainTile } from "@mmo-engine/protocol";

export interface WorldTerrain {
  dataDir: string;
  chunkWorldSize: number;
  seed: string;
  /** False when the world has no stored tiles yet (shown as generated). */
  stored: boolean;
  amplitude: number;
  frequency: number;
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

export async function loadTerrain(): Promise<WorldTerrain> {
  const json = await call<Omit<WorldTerrain, "tiles"> & { tiles: WireTile[] }>("/api/editor/terrain");
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
