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
 * names another ecology plan file.
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEcologyPlan } from "./ecology.js";
import { makeEcologyPopulator, makeScatterPopulator } from "./scatter-spawn.js";
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

export function makeWorldPopulator(opts: {
  worldSeed: bigint;
  chunkWorldSize: number;
  seaLevel?: number;
  biomeAt?: (x: number, z: number) => string | null;
  waterAt?: (x: number, z: number) => number | null;
  /** The terrain the chunks are generated from (formation layers read neighbouring chunks). */
  terrain?: ChunkDataSource;
  /** world.db's formation tiles, and the terrain version they're solved on. */
  formationTiles?: { store: FormationTileStore; terrainVersion: string };
  log?: (line: string) => void;
}): WorldPopulator {
  const kind = process.env.MMO_SCATTER || (fs.existsSync(ART_MANIFEST) ? "ecology" : "pcg");
  if (kind !== "ecology" && kind !== "pcg") throw new Error(`MMO_SCATTER=${kind}: want ecology or pcg`);
  if (kind === "pcg") {
    const p = makeScatterPopulator(opts.worldSeed, opts.chunkWorldSize, opts.seaLevel === undefined ? {} : { seaLevel: opts.seaLevel });
    opts.log?.("[scatter] PCG forest graph (PICG trees)");
    return { ...p, planHash: p.planHash, kind };
  }
  const file = process.env.MMO_ECOLOGY || DEFAULT_ECOLOGY_PLAN;
  const { plan, hash } = loadEcologyPlan(file);
  opts.log?.(
    `[scatter] ecology plan "${plan.name}": ${plan.layers.length} layers` +
      `${opts.biomeAt ? ", by biome" : ""}${opts.waterAt ? ", by water" : ""} (${file})`,
  );
  const p = makeEcologyPopulator(opts.worldSeed, opts.chunkWorldSize, {
    plan,
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
