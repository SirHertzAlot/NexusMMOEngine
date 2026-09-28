/**
 * The engine's PCG asset library: `content/pcg/index.json` names every
 * game asset a graph generates and every reusable part (`.pcgsubgraph`)
 * graphs may link.
 *
 * ```json
 * {
 *   "version": 1,
 *   "subgraphs": [{ "guid": "…32 hex…", "file": "parts/trunk.pcgsubgraph" }],
 *   "assets": [{ "id": "oak", "graph": "trees/oak.pcg", "variants": 4 }]
 * }
 * ```
 *
 * An asset id is the one spawn tables use: entities carry
 * `AssetRef.assetHash = fnv1a32(id)` and a u16 variant, which picks one of
 * the asset's `variants` cooked shapes (each its own seed).
 */

export interface PcgLibraryIndex {
  version: 1;
  subgraphs: Array<{ guid: string; file: string; name?: string }>;
  assets: PcgLibraryAsset[];
}

export interface PcgLibraryAsset {
  /** Spawn-table asset id. */
  id: string;
  /** Path of the asset's `.pcg`, relative to the library root. */
  graph: string;
  /** Distinct cooked shapes (seeds); an entity's variant picks one. Default 1. */
  variants?: number;
  /** Parameter values for this asset (by id or name), over the graph's defaults. */
  parameters?: Record<string, unknown>;
  displayName?: string;
}

/** FNV-1a 32-bit — the AssetRef hash of an asset id (same as @mmo-engine/scatter). */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Which cooked shape an entity's AssetRef.variant shows. */
export function variantIndex(asset: PcgLibraryAsset, variant: number): number {
  const n = Math.max(1, Math.floor(asset.variants ?? 1));
  return (variant >>> 0) % n;
}

/** The cook seed for one of an asset's shapes (a positive int32, as pcg-core takes). */
export function variantSeed(asset: PcgLibraryAsset, index: number): number {
  return fnv1a32(`${asset.id}#${index}`) & 0x7fffffff;
}

/** Throws with a readable message unless `value` is a well-formed library index. */
export function parseLibraryIndex(value: unknown): PcgLibraryIndex {
  const fail = (msg: string): never => {
    throw new Error(`pcg library index: ${msg}`);
  };
  const v = value as PcgLibraryIndex;
  if (!v || typeof v !== "object") fail("not an object");
  if (v.version !== 1) fail(`version ${String(v.version)} (want 1)`);
  if (!Array.isArray(v.subgraphs)) fail("subgraphs must be an array");
  if (!Array.isArray(v.assets)) fail("assets must be an array");
  const ids = new Set<string>();
  for (const a of v.assets) {
    if (typeof a.id !== "string" || !a.id) fail("asset without an id");
    if (ids.has(a.id)) fail(`duplicate asset id '${a.id}'`);
    ids.add(a.id);
    if (typeof a.graph !== "string" || !a.graph) fail(`asset '${a.id}' has no graph`);
    if (a.variants !== undefined && !(Number.isInteger(a.variants) && a.variants >= 1 && a.variants <= 64)) {
      fail(`asset '${a.id}': variants must be an integer 1..64`);
    }
  }
  const guids = new Set<string>();
  for (const s of v.subgraphs) {
    if (typeof s.guid !== "string" || !/^[0-9a-f]{32}$/.test(s.guid)) fail(`subgraph guid '${String(s.guid)}' must be 32 lower-case hex`);
    if (guids.has(s.guid)) fail(`duplicate subgraph guid '${s.guid}'`);
    guids.add(s.guid);
    if (typeof s.file !== "string" || !s.file) fail(`subgraph ${s.guid} has no file`);
  }
  return v;
}
