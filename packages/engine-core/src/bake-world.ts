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
 *   MMO_BAKE_RADIUS chunk radius around (0,0); 0 = single chunk (default 1 = 3x3,
 *                   the same area the server loads on a fresh boot)
 *   MMO_BAKE_FORCE=1 overwrite an existing world.db (default: refuse);
 *                   same as the --force flag / bake:world:force script
 *   MMO_TERRAIN_AMPLITUDE / MMO_TERRAIN_FREQUENCY  terrain shape; the
 *                   server must run with the same values (it warns on a
 *                   mismatch, recorded as meta "terrain_version")
 *
 * The chunk heightfields are stored as terrain tiles in the same world.db
 * (the world heightmap): the server reads them instead of regenerating,
 * and the editor's Terrain panel sculpts them.
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
} from "./index.js";
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

  const sim = new SimWorld();
  const procgen = makeProcgenChunkSource(terrainOptionsFromEnv());
  const scatterContent = loadScatterContent();
  const scatterBinding = makeScatterBinding();

  let chunks = 0;
  let scattered = 0;
  const bakedTiles: TerrainTile[] = [];
  for (let cz = -RADIUS; cz <= RADIUS; cz++) {
    for (let cx = -RADIUS; cx <= RADIUS; cx++) {
      const { heights } = spawnChunk(sim, procgen, WORLD_SEED, cx, cz, 0);
      bakedTiles.push({ cx, cz, heights });
      scattered += scatterChunkToECS(sim, scatterBinding, scatterContent, {
        worldSeed: WORLD_SEED,
        cx,
        cz,
        heights,
        chunkWorldSize: CHUNK_SIZE,
      }).length;
      chunks++;
    }
  }

  const store = new SnapshotStore({ dbPath });
  const result = store.saveWorld(0, sim);
  store.setMeta("terrain_version", String(procgen.terrainVersion));
  store.close();
  // The world heightmap is stored with the world: the server reads these
  // tiles instead of regenerating, and the editor sculpts them.
  const tiles = new TerrainTileStore(dbPath);
  tiles.putMany(bakedTiles);
  tiles.close();

  console.log(
    `[bake] seed=${WORLD_SEED} terrain=amp ${procgen.amplitude}/freq ${procgen.frequency} ` +
      `(v${procgen.terrainVersion}) chunks=${chunks} tiles=${bakedTiles.length} ` +
      `scattered=${scattered} entities=${sim.liveEntityCount} ` +
      `plan=${scatterContent.planHash.slice(0, 12)}… ` +
      `tick=${result.tick} db=${dbPath}`,
  );
}

main().catch((err) => {
  console.error(`[bake] failed: ${(err as Error).message}`);
  process.exit(1);
});
