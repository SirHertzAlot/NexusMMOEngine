/**
 * What grows on a chunk the first time it loads — one choice for the
 * server and the world bake alike:
 *
 *  - "ecology": natural placement of the art packs' nature set (trees in
 *    groves, scree round boulders, flower patches, reeds at the shore —
 *    see ecology.ts and content/ecology/wilds.ecology.json);
 *  - "pcg": the PCG forest graph, drawn with PICG's cooked trees.
 *
 * MMO_SCATTER picks one; by default it's ecology when the art packs are
 * on this machine (clients here can draw them), else pcg. MMO_ECOLOGY
 * names another ecology plan file. The ecology plan's per-biome multipliers
 * come from the biome registry (content/biomes.json, or MMO_BIOMES; see
 * biome-registry.ts).
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEcologyPlan } from "./ecology.js";
import { applyBiomeScatter, checkBiomeRegistry, DEFAULT_BIOME_REGISTRY, ecologyGroups, loadBiomeRegistry, type BiomeRegistry } from "./biome-registry.js";
import { makeEcologyPopulator, makeScatterPopulator } from "./scatter-spawn.js";
import { loadScale, type ScaleResolver } from "../scale.js";
import { catalogBounds, pcgBounds, type ModelBounds } from "./prop-shape.js";
import { DEFAULT_PCG_ASSETS, loadNativeCooker } from "../pcg/boot.js";
import { PcgAssetLibrary } from "../pcg/asset-library.js";
import type { SimWorld } from "../world.js";
import type { ChunkDataSource } from "./chunk-source.js";
import type { FormationTileStore } from "../persist/formation-tiles.js";

export interface WorldPopulator {
  populate(world: SimWorld, cx: number, cz: number, heights: Float32Array): void;
  readonly planHash: string;
  readonly kind: "ecology" | "pcg";
  /**
   * Solve every formation tile over chunks [minChunk, maxChunk] into the
   * formation store (the bake); the server then only reads them.
   */
  bakeFormations?(
    minChunk: { x: number; z: number },
    maxChunk: { x: number; z: number },
    onTile?: (done: number, total: number) => void,
  ): { tiles: number; solved: number };
}

/** The art packs' manifest in this checkout (present only where the art is). */
export const ART_MANIFEST = fileURLToPath(new URL("../../../../../assets/manifest.json", import.meta.url));
export const DEFAULT_ECOLOGY_PLAN = fileURLToPath(new URL("../../../content/ecology/wilds.ecology.json", import.meta.url));

/** The art catalog next to the manifest: model sizes for the ecology's colliders (null where the art isn't). */
export const ART_CATALOG = fileURLToPath(new URL("../../../../../assets/catalog.json", import.meta.url));

/** The PICG trees' sizes from their cooked meshes (undefined without the native cook or the library). */
async function loadPcgBounds(): Promise<ModelBounds | undefined> {
  const dir = process.env.MMO_PCG_ASSETS || DEFAULT_PCG_ASSETS;
  const { cooker } = loadNativeCooker();
  if (!cooker || !fs.existsSync(`${dir}/index.json`)) return undefined;
  return pcgBounds(PcgAssetLibrary.load(dir, cooker));
}

export async function makeWorldPopulator(opts: {
  worldSeed: bigint;
  chunkWorldSize: number;
  seaLevel?: number;
  biomeAt?: (x: number, z: number) => string | null;
  waterAt?: (x: number, z: number) => number | null;
  /** The terrain the chunks are generated from (formation layers read neighbouring chunks). */
  terrain?: ChunkDataSource;
  /** world.db's formation tiles, and the terrain version they're solved on. */
  formationTiles?: { store: FormationTileStore; terrainVersion: string };
  /** Per-biome scatter multipliers (default: loaded from MMO_BIOMES or content/biomes.json). */
  biomes?: BiomeRegistry;
  /** The global scale (default: content/scale.json or MMO_SCALE; a bad file throws). */
  scale?: ScaleResolver;
  log?: (line: string) => void;
}): Promise<WorldPopulator> {
  const scale = opts.scale ?? loadScale();
  const kind = process.env.MMO_SCATTER || (fs.existsSync(ART_MANIFEST) ? "ecology" : "pcg");
  if (kind !== "ecology" && kind !== "pcg") throw new Error(`MMO_SCATTER=${kind}: want ecology or pcg`);
  if (kind === "pcg") {
    const bounds = await loadPcgBounds();
    const p = makeScatterPopulator(opts.worldSeed, opts.chunkWorldSize, { bounds, scale, ...(opts.seaLevel === undefined ? {} : { seaLevel: opts.seaLevel }), ...(opts.waterAt ? { waterAt: opts.waterAt } : {}) });
    opts.log?.(`[scatter] PCG forest graph (PICG trees, colliders ${bounds ? "from the cooked meshes" : "default boxes: no native cook"})`);
    return { ...p, planHash: p.planHash, kind };
  }
  const file = process.env.MMO_ECOLOGY || DEFAULT_ECOLOGY_PLAN;
  const loaded = loadEcologyPlan(file);
  const registry = opts.biomes ?? loadBiomeRegistry(process.env.MMO_BIOMES || DEFAULT_BIOME_REGISTRY).registry;
  const problems = checkBiomeRegistry(registry, { scatterGroups: ecologyGroups(loaded.plan) });
  if (problems.length > 0) throw new Error(`biome registry against ecology plan "${loaded.plan.name}": ${problems.join("; ")}`);
  const { plan, hash } = applyBiomeScatter(loaded.plan, loaded.hash, registry);
  opts.log?.(
    `[scatter] ecology plan "${plan.name}": ${plan.layers.length} layers` +
      `${opts.biomeAt ? `, by biome (${Object.keys(registry.biomes).length} in the registry)` : ""}${opts.waterAt ? ", by water" : ""} (${file})`,
  );
  const bounds = fs.existsSync(ART_CATALOG) ? catalogBounds(ART_CATALOG) : undefined;
  if (!bounds) opts.log?.("[scatter] no art catalog: ecology props without an explicit shape get default boxes");
  const p = makeEcologyPopulator(opts.worldSeed, opts.chunkWorldSize, {
    plan,
    bounds,
    scale,
    planHash: hash,
    biomeAt: opts.biomeAt,
    waterAt: opts.waterAt,
    seaLevel: opts.seaLevel,
    terrain: opts.terrain,
    formationTiles: opts.formationTiles?.store.backing({
      worldSeed: opts.worldSeed,
      terrainVersion: opts.formationTiles.terrainVersion,
      planHash: hash,
    }),
  });
  return { populate: p.populate, planHash: p.planHash, kind, bakeFormations: p.bakeFormations };
}
