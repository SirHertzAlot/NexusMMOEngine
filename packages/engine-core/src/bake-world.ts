/**
 * bake-world: pre-generate terrain + scatter into a world.db offline.
 *
 * Usage:
 *   npm run bake:world          bake if no world exists yet
 *   npm run bake:world:force    replace an existing world (stop the server first)
 *
 * Env:
 *   MMO_DATA_DIR    where world.db is written (default ./data)
 *   MMO_WORLD_SEED  u64 region seed (default 1234)
 *   MMO_CHUNK_SIZE  chunk world size in units (default 16)
 *   MMO_WORLD_SPEC  world spec JSON (default worlds/default.world.json: a
 *                   4 x 4 km world); "none" = the legacy 3x3-chunk world
 *   MMO_WORLD_CATALOG=0  skip the SurrealDB catalog (data/surreal)
 *   MMO_BAKE_RADIUS spawn-area chunk radius around (0,0) that gets entities
 *                   and scatter (default 1 = 3x3; the server loads the same)
 *   MMO_BAKE_FORCE=1 overwrite an existing world.db (default: refuse);
 *                   same as the --force flag / bake:world:force script
 *   MMO_TERRAIN_AMPLITUDE / MMO_TERRAIN_FREQUENCY  terrain shape; the
 *                   server must run with the same values (it warns on a
 *                   mismatch, recorded as meta "terrain_version")
 *
 * With a world spec, the WHOLE world's terrain is baked once (survey,
 * erosion, rivers, biomes -> 16x16-sample chunk tiles + survey maps in
 * world.db, catalog in SurrealDB); entities and scatter are placed only in
 * the spawn area — the rest of the world streams in later. The server reads
 * the stored tiles instead of regenerating, and the editor sculpts them.
 *
 * This runs the exact chunk-load sequence the server uses on a fresh
 * boot (spawnChunk + scatterChunkToECS per chunk), then saves tick 0
 * to SQLite and exits. Start the server afterwards with the same
 * MMO_DATA_DIR / MMO_WORLD_SEED and it restores the baked world
 * ("restored at tick 0") instead of generating — so the world players
 * connect to is stable and deterministic. Clients receive it through
 * the normal welcome snapshot on connect.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SimWorld,
  SnapshotStore,
  loadScatterContent,
  makeProcgenChunkSource,
  makeScatterBinding,
  scatterChunkToECS,
  spawnChunk,
  terrainOptionsFromEnv,
  TerrainTileStore,
  makeTileChunkSource,
  type ChunkDataSource,
} from "./index.js";
import { closeWorldCatalogs } from "./persist/world-catalog.js";
import { bakeWorldTerrain } from "./terrain/world-bake.js";
import { loadWorldSpec, worldBounds, type WorldSpec } from "./terrain/world-spec.js";
import type { TerrainTile } from "@mmo-engine/protocol";

const DATA_DIR = path.resolve(process.env.MMO_DATA_DIR ?? "./data");
const WORLD_SEED = BigInt(process.env.MMO_WORLD_SEED ?? 1234);
const CHUNK_SIZE = Number(process.env.MMO_CHUNK_SIZE ?? 16);
const RADIUS = Number(process.env.MMO_BAKE_RADIUS ?? 1);
const FORCE =
  process.env.MMO_BAKE_FORCE === "1" || process.argv.includes("--force");

async function main(): Promise<void> {
  if (!Number.isInteger(RADIUS) || RADIUS < 0) {
    throw new Error(`MMO_BAKE_RADIUS must be a non-negative integer (got ${process.env.MMO_BAKE_RADIUS})`);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, "world.db");

  const probe = new SnapshotStore({ dbPath });
  const existing = probe.snapshotCount();
  probe.close();
  if (existing > 0 && !FORCE) {
    throw new Error(
      `refusing to overwrite ${dbPath} (${existing} snapshot(s) present). ` +
        `To replace it, stop the server and run: npm run bake:world:force`,
    );
  }
  if (existing > 0) {
    // Remove the WAL sidecars too: a stale world.db-wal next to a fresh
    // world.db could replay old pages into the new world.
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "EBUSY" || code === "EPERM") {
          throw new Error(
            `${path.basename(f)} is open in another program — usually the ` +
              `game server (Ctrl+C in its terminal) or a SQLite viewer/editor ` +
              `tab showing world.db. Close it, then run the bake again.`,
          );
        }
        throw err;
      }
    }
  }

  const spec = resolveWorldSpec();
  const worldSeed = spec ? BigInt(spec.seed) : WORLD_SEED;
  const chunkSize = spec ? spec.chunkWorldSize : CHUNK_SIZE;
  if (spec && process.env.MMO_WORLD_SEED !== undefined && BigInt(process.env.MMO_WORLD_SEED) !== worldSeed) {
    console.warn(`[bake] MMO_WORLD_SEED=${process.env.MMO_WORLD_SEED} ignored: the world spec's seed (${spec.seed}) defines this world`);
  }

  // ---- terrain: the whole world, once (spec worlds) ----------------------
  const procgen = makeProcgenChunkSource(terrainOptionsFromEnv());
  let terrain: ChunkDataSource = procgen;
  let tiles: TerrainTileStore | null = null;
  if (spec) {
    const report = await bakeWorldTerrain(spec, {
      dbPath,
      catalogDir: process.env.MMO_WORLD_CATALOG === "0" ? null : path.join(DATA_DIR, "surreal"),
      log: (l) => console.log(l),
    });
    // The bake is the catalog's only user here; an open connection would
    // keep this process alive.
    await closeWorldCatalogs();
    console.log(
      `[bake] terrain: ${report.chunks} chunks (${spec.sizeChunks * spec.chunkWorldSize / 1000} km square), ` +
        `heights ${report.heightRange.min}..${report.heightRange.max} m, ${report.riverChunks} river chunks, ` +
        `erosion mean ${report.erosion.meanM.toFixed(2)} m, peak memory ${report.peakRssMb} MB`,
    );
    // Entities are placed on the STORED terrain, exactly as the server reads it.
    tiles = new TerrainTileStore(dbPath);
    terrain = makeTileChunkSource(tiles, procgen);
  }

  // ---- entities: only the spawn area (the rest streams in later) ---------
  const sim = new SimWorld();
  const scatterContent = loadScatterContent();
  const scatterBinding = makeScatterBinding();

  let chunks = 0;
  let scattered = 0;
  const bakedTiles: TerrainTile[] = [];
  for (let cz = -RADIUS; cz <= RADIUS; cz++) {
    for (let cx = -RADIUS; cx <= RADIUS; cx++) {
      const { heights } = spawnChunk(sim, terrain, worldSeed, cx, cz, 0);
      bakedTiles.push({ cx, cz, heights });
      scattered += scatterChunkToECS(sim, scatterBinding, scatterContent, {
        worldSeed,
        cx,
        cz,
        heights,
        chunkWorldSize: chunkSize,
      }).length;
      chunks++;
    }
  }
  tiles?.close();

  const store = new SnapshotStore({ dbPath });
  const result = store.saveWorld(0, sim);
  store.setMeta("terrain_version", String(procgen.terrainVersion));
  if (spec) {
    store.setMeta("world_spec", spec.name);
    store.setMeta("world_seed", String(spec.seed));
    // Chunk range the world covers (the editor loads areas inside it).
    const { minChunk, maxChunk } = worldBounds(spec);
    store.setMeta("world_bounds", JSON.stringify({ minChunk, maxChunk }));
  }
  store.close();
  if (!spec) {
    // Legacy small world: store the spawn area's heights as the world's tiles.
    const legacy = new TerrainTileStore(dbPath);
    legacy.putMany(bakedTiles);
    legacy.close();
  }

  console.log(
    `[bake] seed=${worldSeed} ${spec ? `world "${spec.name}"` : `terrain=amp ${procgen.amplitude}/freq ${procgen.frequency} (v${procgen.terrainVersion})`} ` +
      `spawn chunks=${chunks} scattered=${scattered} entities=${sim.liveEntityCount} ` +
      `plan=${scatterContent.planHash.slice(0, 12)}… ` +
      `tick=${result.tick} db=${dbPath}`,
  );
}

/**
 * The world spec to bake: MMO_WORLD_SPEC (a path, or "none" for the legacy
 * small world), else worlds/default.world.json when present.
 */
function resolveWorldSpec(): WorldSpec | null {
  const env = process.env.MMO_WORLD_SPEC;
  if (env === "none") return null;
  const file = env
    ? path.resolve(env)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../worlds/default.world.json");
  if (!fs.existsSync(file)) {
    if (env) throw new Error(`MMO_WORLD_SPEC: ${file} not found`);
    return null;
  }
  console.log(`[bake] world spec ${path.relative(process.cwd(), file)}`);
  return loadWorldSpec(file);
}

main().catch((err) => {
  console.error(`[bake] failed: ${(err as Error).message}`);
  process.exit(1);
});
