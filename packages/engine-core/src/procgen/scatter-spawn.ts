/**
 * scatter-spawn.ts — region chunk-load integration (PCG slice 4).
 *
 * Turns cooked scatter plans into ECS entities when a chunk loads.
 * The pipeline is:
 *
 *   1. Chunk heightmap already generated (spawnChunk / ChunkDataSource).
 *   2. `scatterChunkToECS` builds the height tile the native addon wants,
 *      calls @mmo-engine/addon-scatter, and resolves the spawn records
 *      against the spawn table (@mmo-engine/scatter).
 *   3. Each resolved spawn becomes an entity: Transform (position from
 *      the record, yaw->quaternion, scale), AssetRef (assetHash/variant),
 *      plus Health when the archetype declares it (breakable resources)
 *      and Velocity+BodyConfig unless its collision is "none" (a default
 *      box when it declares none at all; static bodies are picked up by PhysicsSystem on the next tick via its membership
 *      diff — no special wiring).
 *
 * Design decisions (explicit, not accidental):
 *
 * - Scatter output is a pure function of (worldSeed, cx, cz, plan,
 *   spawn table). Entities persist through the normal snapshot path
 *   like every other entity; scatter runs only when the chunk entity is
 *   *spawned* (fresh boot), never on reboot restore, so there are no
 *   duplicates. A plan/table change therefore needs a content version
 *   bump (future: scatterVersion on the Chunk component); until then a
 *   plan change requires a fresh database.
 * - Harvesting a scattered entity (breaking it) is a normal ECS
 *   mutation and persists. If the chunk is ever re-scattered the entity
 *   returns — depletion records are a later slice's problem.
 * - worldSeed is u64 on the region; the scatter addon takes u32.
 *   Reduction is hashU32(hi ^ lo) — deterministic and avalanched.
 * - Runs at chunk load, outside the 30 Hz tick path. The native call
 *   is synchronous and microsecond-scale for typical spawn counts;
 *   no worker thread needed (same posture as the navmesh bake).
 *
 * SOLID: engine code depends only on the narrow `ScatterBinding`
 * interface, so the native addon can be swapped without touching
 * callers. Plan/table loading is cached — cook once per process.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addComponent } from "bitecs";
import {
  AssetRef,
  BodyConfig,
  Health,
  MotionType,
  ShapeKind,
  Transform,
  Velocity,
} from "../components.js";
import type { SimWorld } from "../world.js";
import { attachDefaultCollider } from "../systems.js";
import {
  cook,
  hashU32,
  parseGraphJSON,
  parseSpawnTableJSON,
  resolveSpawns,
  type CookedPlan,
  type EntitySpawn,
  type SpawnRecord,
  type SpawnTable,
} from "@mmo-engine/scatter";
import { ecologySeed32, planChunk, type EcologyPlan } from "./ecology.js";
import { bakeFormations, FormationCache, type FormationTileBacking } from "./formation.js";
import type { ChunkDataSource } from "./chunk-source.js";

/** Narrow interface for the native scatter addon. */
export interface ScatterBinding {
  scatterChunk(args: {
    plan: CookedPlan;
    worldSeed: number;
    cx: number;
    cz: number;
    heights: Float64Array;
    gridN: number;
    gridOx: number;
    gridOz: number;
    gridStep: number;
  }): SpawnRecord[];
}

/**
 * Build a ScatterBinding backed by @mmo-engine/addon-scatter.
 * Throws a helpful error when the native binding is not built
 * (run `npm install` at the repo root first).
 */
export function makeScatterBinding(): ScatterBinding {
  const require = createRequire(import.meta.url);
  let addon: ScatterBinding;
  try {
    // The addon is a CJS native binding; require keeps ESM/CJS interop simple.
    addon = require("@mmo-engine/addon-scatter") as ScatterBinding;
  } catch (err) {
    throw new Error(
      "scatter-spawn: @mmo-engine/addon-scatter is not built. " +
        "Run `npm install` at the repo root to build the native addon. " +
        `Underlying error: ${(err as Error).message}`,
    );
  }
  if (typeof addon.scatterChunk !== "function") {
    throw new Error(
      "scatter-spawn: @mmo-engine/addon-scatter does not export scatterChunk.",
    );
  }
  return addon;
}

/** Cooked plan + spawn table pair used for one chunk scatter. */
export interface ScatterContent {
  plan: CookedPlan;
  table: SpawnTable;
  /** sha256 of the cooked plan (plan identity, for future versioning). */
  planHash: string;
}

let cached: ScatterContent | null = null;

/**
 * Load and cook the scatter content once per process. v1 uses the
 * forest example shipped with @mmo-engine/scatter; the biome registry
 * (slice 5) will select the plan per chunk instead.
 */
export function loadScatterContent(): ScatterContent {
  if (cached) return cached;
  const scatterEntry = fileURLToPath(
    import.meta.resolve("@mmo-engine/scatter"),
  );
  const examplesDir = join(dirname(scatterEntry), "..", "..", "examples");
  const planJson = JSON.parse(
    readFileSync(join(examplesDir, "forest.pcg.json"), "utf8"),
  );
  const tableJson = JSON.parse(
    readFileSync(join(examplesDir, "forest.spawn-table.json"), "utf8"),
  );
  const cooked = cook(parseGraphJSON(planJson));
  cached = {
    plan: cooked,
    table: parseSpawnTableJSON(tableJson),
    planHash: cooked.hash,
  };
  return cached;
}

/** Options for scattering one chunk into the ECS world. */
export interface ScatterChunkOptions {
  /** Region world seed (u64). Reduced to u32 for the addon. */
  worldSeed: bigint;
  cx: number;
  cz: number;
  /** Chunk heightmap from spawnChunk: side*side floats, row-major. */
  heights: Float32Array;
  /** Chunk world size in units (default 16, matches MMO_CHUNK_SIZE). */
  chunkWorldSize?: number;
  /** Nothing is placed below this height (the sea: no trees on the sea floor). */
  minHeight?: number;
}

/**
 * Reduce the u64 region seed to the u32 the scatter addon takes.
 * Exported for tests (determinism contract).
 */
export function scatterSeedU32(worldSeed: bigint): number {
  const hi = Number((worldSeed >> 32n) & 0xffffffffn);
  const lo = Number(worldSeed & 0xffffffffn);
  return hashU32((hi ^ lo) >>> 0);
}

/** Yaw-only rotation as a quaternion (rotation about +Y). */
function yawToQuat(yaw: number): { qx: number; qy: number; qz: number; qw: number } {
  const h = yaw / 2;
  return { qx: 0, qy: Math.sin(h), qz: 0, qw: Math.cos(h) };
}

/**
 * Spawn one resolved scatter record as ECS entities. Returns the eid.
 * Exported for tests.
 */
export function spawnScatterEntity(world: SimWorld, s: EntitySpawn): number {
  const eid = world.spawn();
  const T = Transform;
  addComponent(world.ecs, T, eid);
  T.px[eid] = s.x; T.py[eid] = s.y; T.pz[eid] = s.z;
  const q = yawToQuat(s.yaw);
  T.qx[eid] = q.qx; T.qy[eid] = q.qy; T.qz[eid] = q.qz; T.qw[eid] = q.qw;
  T.sx[eid] = s.sx; T.sy[eid] = s.sy; T.sz[eid] = s.sz;

  const A = AssetRef;
  addComponent(world.ecs, A, eid);
  A.assetHash[eid] = s.assetHash;
  A.variant[eid] = s.variant;

  // Breakable resources: the archetype's health becomes a live component.
  if (s.archetype.health) {
    const H = Health;
    addComponent(world.ecs, H, eid);
    H.current[eid] = s.archetype.health.max;
    H.max[eid] = s.archetype.health.max;
  }

  // Collision: every prop is a physics body unless its data says
  // "shape": "none" (grass, flowers); an archetype that doesn't say gets
  // a static box the size of its scale. PhysicsSystem owns [Transform,
  // Velocity, BodyConfig] entities, so Velocity (zeroed) rides along.
  const col = s.archetype.collision;
  if (!col) {
    attachDefaultCollider(world, eid);
  } else if (col.shape !== "none") {
    const V = Velocity;
    addComponent(world.ecs, V, eid);
    V.lx[eid] = 0; V.ly[eid] = 0; V.lz[eid] = 0;
    V.ax[eid] = 0; V.ay[eid] = 0; V.az[eid] = 0;
    const B = BodyConfig;
    addComponent(world.ecs, B, eid);
    if (col.shape === "sphere" && col.radius) {
      B.shapeKind[eid] = ShapeKind.Sphere;
      B.halfX[eid] = 0; B.halfY[eid] = 0; B.halfZ[eid] = 0;
      B.radius[eid] = col.radius;
    } else {
      // box (halfExtents optional in the schema; fall back to unit box
      // rather than silently dropping collision).
      const he = col.halfExtents ?? [0.5, 0.5, 0.5];
      B.shapeKind[eid] = ShapeKind.Box;
      B.halfX[eid] = he[0]; B.halfY[eid] = he[1]; B.halfZ[eid] = he[2];
      B.radius[eid] = 0;
    }
    B.mass[eid] = 0;
    B.motionType[eid] = MotionType.Static;
    B.layer[eid] = 0; // NON_MOVING
    B.friction[eid] = 0.8;
    B.restitution[eid] = 0;
  }
  return eid;
}

/**
 * Run the scatter pipeline for one chunk and spawn the results.
 * Returns the spawned entity ids (slot eids, not wire ids).
 */
export function scatterChunkToECS(
  world: SimWorld,
  binding: ScatterBinding,
  content: ScatterContent,
  opts: ScatterChunkOptions,
): number[] {
  const n = opts.heights.length;
  const side = Math.sqrt(n);
  if (!Number.isInteger(side) || side < 2) {
    throw new Error(
      `scatter-spawn: heights must be a square >= 4, got length ${n}`,
    );
  }
  const chunkWorldSize = opts.chunkWorldSize ?? 16;
  // The addon wants f64; the tile covers the chunk exactly, matching the
  // node layout buildChunkMesh uses (step = size / (side - 1)).
  const tile = new Float64Array(n);
  for (let i = 0; i < n; i++) tile[i] = opts.heights[i];

  const records = binding.scatterChunk({
    plan: content.plan,
    worldSeed: scatterSeedU32(opts.worldSeed),
    cx: opts.cx,
    cz: opts.cz,
    heights: tile,
    gridN: side,
    gridOx: opts.cx * chunkWorldSize,
    gridOz: opts.cz * chunkWorldSize,
    gridStep: chunkWorldSize / (side - 1),
  });

  const minHeight = opts.minHeight ?? -Infinity;
  const spawns = resolveSpawns(records, content.table).filter((s) => s.y >= minHeight);
  return spawns.map((s) => spawnScatterEntity(world, s));
}

/**
 * A chunk's first-load contents for the ChunkStreamer: the scatter plan
 * run over its heights. Loads the plan and the native binding once.
 */
/** Scatter stays this far above the sea (props don't stand in the surf). */
const SHORE_CLEARANCE_M = 0.2;

export function makeScatterPopulator(
  worldSeed: bigint,
  chunkWorldSize: number,
  opts: { seaLevel?: number } = {},
): {
  populate(world: SimWorld, cx: number, cz: number, heights: Float32Array): void;
  readonly planHash: string;
} {
  const content = loadScatterContent();
  const binding = makeScatterBinding();
  return {
    planHash: content.planHash,
    populate(world, cx, cz, heights) {
      scatterChunkToECS(world, binding, content, {
        worldSeed,
        cx,
        cz,
        heights,
        chunkWorldSize,
        minHeight: opts.seaLevel === undefined ? undefined : opts.seaLevel + SHORE_CLEARANCE_M,
      });
    },
  };
}

/**
 * A chunk's first-load contents from an ecology plan (natural placement,
 * see ecology.ts) instead of a scatter graph: same entities (Transform,
 * AssetRef, collision), placed by the plan's formations.
 */
export function makeEcologyPopulator(
  worldSeed: bigint,
  chunkWorldSize: number,
  opts: {
    plan: EcologyPlan;
    planHash: string;
    biomeAt?: (x: number, z: number) => string | null;
    waterAt?: (x: number, z: number) => number | null;
    seaLevel?: number;
    /** The terrain, for formation layers (their tiles span and border other chunks). */
    terrain?: ChunkDataSource;
    /** Where solved formation tiles persist (world.db): the bake fills it, the server reads it. */
    formationTiles?: FormationTileBacking;
  },
): {
  populate(world: SimWorld, cx: number, cz: number, heights: Float32Array): void;
  readonly planHash: string;
  /** Solve every formation tile over chunks [minChunk, maxChunk]; returns the tiles covered and how many were solved (not already stored). */
  bakeFormations(minChunk: { x: number; z: number }, maxChunk: { x: number; z: number }, onTile?: (done: number, total: number) => void): { tiles: number; solved: number };
} {
  // Formations read neighbouring chunks' heights and reuse solved tiles across chunks.
  const heightCache = new Map<string, Float32Array>();
  const terrain = opts.terrain;
  const heightsOf = terrain
    ? (cx: number, cz: number): Float32Array => {
        const key = `${cx},${cz}`;
        let h = heightCache.get(key);
        if (!h) {
          h = new Float32Array(terrain.chunkSamples);
          terrain.generateChunk(worldSeed, cx, cz, 0, h);
          heightCache.set(key, h);
          if (heightCache.size > 4096) heightCache.delete(heightCache.keys().next().value as string);
        }
        return h;
      }
    : undefined;
  const formations = new FormationCache(1024, opts.formationTiles ?? null);
  return {
    planHash: opts.planHash,
    bakeFormations(minChunk, maxChunk, onTile) {
      if (!opts.plan.layers.some((l) => l.place.kind === "formation")) return { tiles: 0, solved: 0 };
      if (!heightsOf) throw new Error("ecology: baking formations needs the terrain");
      const before = formations.solved;
      const env = { seed32: ecologySeed32(worldSeed), chunkWorldSize, heightsOf, biomeAt: opts.biomeAt, waterAt: opts.waterAt, seaLevel: opts.seaLevel };
      const tiles = bakeFormations(opts.plan, env, formations, minChunk, maxChunk, onTile);
      return { tiles, solved: formations.solved - before };
    },
    populate(world, cx, cz, heights) {
      const points = planChunk(opts.plan, {
        worldSeed,
        cx,
        cz,
        heights,
        chunkWorldSize,
        biomeAt: opts.biomeAt,
        waterAt: opts.waterAt,
        seaLevel: opts.seaLevel,
        heightsOf,
        formations,
      });
      for (const p of points) spawnScatterEntity(world, p);
    },
  };
}
