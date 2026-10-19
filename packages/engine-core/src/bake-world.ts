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
 *   MMO_BAKE_RADIUS spawn-area chunk radius around the spawn point that gets
 *                   entities and scatter (default 1 = 3x3; the server keeps
 *                   the same area loaded, MMO_WORLD_RADIUS)
 *   MMO_BAKE_FORCE=1 overwrite an existing world.db (default: refuse);
 *                   same as the --force flag / bake:world:force script
 *   MMO_TERRAIN_AMPLITUDE / MMO_TERRAIN_FREQUENCY  terrain shape; the
 *                   server must run with the same values (it warns on a
 *                   mismatch, recorded as meta "terrain_version")
 *   MMO_BAKE_REGION=rx,rz  re-bake only this region's tiles (incremental)
 *   MMO_BAKE_SURVEY_ONLY=1  re-run the survey and invalidate the tile cache,
 *                   without regenerating tiles
 *
 * Flags:
 *   --force          overwrite an existing world.db (same as MMO_BAKE_FORCE=1)
 *   --region rx,rz   re-bake only this region's tiles (incremental)
 *   --survey-only    re-run the survey and invalidate the tile cache
 *   --shape=island|peninsula|continents
 *                    the landmass shape (same as MMO_BAKE_SHAPE); continents
 *                    need room, so the world grows to at least
 *                    CONTINENT_MIN_CHUNKS (500 chunks = 8 km) per side
 *   --size-chunks=N  the world's side in chunks (same as MMO_BAKE_SIZE_CHUNKS)
 *
 * With a world spec, the WHOLE world's terrain is baked once (survey,
 * erosion, rivers, biomes -> 16x16-sample chunk tiles + survey maps in
 * world.db, catalog in SurrealDB); entities and scatter are placed only in
 * the spawn area — the rest of the world streams in later. The server reads
 * the stored tiles instead of regenerating, and the editor sculpts them.
 *
 * The spawn area is loaded by the same ChunkStreamer the server streams
 * with (chunk entity + scatter per chunk), then saved as tick 0. Start the server afterwards with the same
 * MMO_DATA_DIR / MMO_WORLD_SEED and it restores the baked world
 * ("restored at tick 0") instead of generating — so the world players
 * connect to is stable and deterministic. Clients receive it through
 * the normal welcome snapshot on connect.
 */

import { makeWorldPopulator } from "./procgen/world-populator.js";
import { FormationTileStore } from "./persist/formation-tiles.js";
import { biomeAtFromMap } from "./terrain/biome-lookup.js";
import { waterSurfaceFromMaps } from "./terrain/water-surface.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChunkEntityStore,
  ChunkStreamer,
  SimWorld,
  SnapshotStore,
  makeProcgenChunkSource,
  terrainOptionsFromEnv,
  TerrainTileStore,
  makeTileChunkSource,
  type ChunkBounds,
  type ChunkDataSource,
} from "./index.js";
import { closeWorldCatalogs } from "./persist/world-catalog.js";
import { bakeWorldTerrain } from "./terrain/world-bake.js";
import { loadWorldSpec, parseWorldSpec, worldBounds, type WorldSpec } from "./terrain/world-spec.js";

const DATA_DIR = path.resolve(process.env.MMO_DATA_DIR ?? "./data");
const WORLD_SEED = BigInt(process.env.MMO_WORLD_SEED ?? 1234);
const CHUNK_SIZE = Number(process.env.MMO_CHUNK_SIZE ?? 16);
const RADIUS = Number(process.env.MMO_BAKE_RADIUS ?? 1);
const FORCE =
  process.env.MMO_BAKE_FORCE === "1" || process.argv.includes("--force");
const SURVEY_ONLY =
  process.env.MMO_BAKE_SURVEY_ONLY === "1" || process.argv.includes("--survey-only");

const SHAPES = ["peninsula", "island", "continents"] as const;
type Shape = (typeof SHAPES)[number];
/** A continents world is at least this many chunks a side: smaller ones would only hold tiny landmasses with little to do on them. */
const CONTINENT_MIN_CHUNKS = 500;
/** `--name=value` on the command line; through `npm run ... -- --name=value` npm keeps the flag for itself and passes it on as npm_config_<name>. */
const flag = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? process.env[`npm_config_${name.replace(/-/g, "_")}`];

function parseShape(arg: string | undefined): Shape | undefined {
  if (!arg) return undefined;
  if (!(SHAPES as readonly string[]).includes(arg)) throw new Error(`shape must be one of ${SHAPES.join(", ")} (got "${arg}")`);
  return arg as Shape;
}
function parseSizeChunks(arg: string | undefined): number | undefined {
  if (!arg) return undefined;
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 2 || n > 4096) throw new Error(`size-chunks must be an integer from 2 to 4096 (got "${arg}")`);
  return n;
}

function parseRegion(arg: string | undefined): [number, number] | undefined {
  if (!arg) return undefined;
  const m = arg.match(/^(\d+),(\d+)$/);
  if (!m) throw new Error(`region must be "rx,rz" (got "${arg}")`);
  return [Number(m[1]), Number(m[2])];
}

const REGION = parseRegion(process.env.MMO_BAKE_REGION ?? process.argv.find((a) => a.startsWith("--region="))?.slice("--region=".length));

async function main(): Promise<void> {
  if (!Number.isInteger(RADIUS) || RADIUS < 0) {
    throw new Error(`MMO_BAKE_RADIUS must be a non-negative integer (got ${process.env.MMO_BAKE_RADIUS})`);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, "world.db");

  const probe = new SnapshotStore({ dbPath });
  const existing = probe.snapshotCount();
  const existingSurveyHash = probe.getMeta("survey_hash");
  probe.close();

  // Incremental mode (--region or --survey-only) works on an existing world.
  // Full bake still refuses to overwrite without --force.
  const incremental = REGION !== undefined || SURVEY_ONLY;
  if (existing > 0 && !incremental && !FORCE) {
    throw new Error(
      `refusing to overwrite ${dbPath} (${existing} snapshot(s) present). ` +
        `To replace it, stop the server and run: npm run bake:world:force`,
    );
  }
  // A forced FULL bake starts clean: drop the db and its WAL sidecars so a
  // stale world.db-wal can't replay old pages into the new world. Incremental
  // mode keeps the existing db — it updates the world in place.
  if (existing > 0 && !incremental && FORCE) {
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
  let spawn = { x: 0, z: 0 };
  let bounds: ChunkBounds | null = null;
  let report: Awaited<ReturnType<typeof bakeWorldTerrain>> | null = null;
  if (spec) {
    report = await bakeWorldTerrain(spec, {
      dbPath,
      catalogDir: process.env.MMO_WORLD_CATALOG === "0" ? null : path.join(DATA_DIR, "surreal"),
      log: (l) => console.log(l),
      terrainVersion: procgen.terrainVersion,
      region: REGION,
      surveyOnly: SURVEY_ONLY,
      existingSurveyHash,
    });
    // The bake is the catalog's only user here; an open connection would
    // keep this process alive.
    await closeWorldCatalogs();
    console.log(
      `[bake] terrain: ${report.chunks} chunks (${spec.sizeChunks * spec.chunkWorldSize / 1000} km square), ` +
        `land ${report.landPercent}%, heights ${report.heightRange.min}..${report.heightRange.max} m, ` +
        `${report.mountainRanges} mountain range(s), ${report.riverChunks} river chunks, ` +
        `erosion mean ${report.erosion.meanM.toFixed(2)} m (deepest river cut ${report.erosion.deepestCutM.toFixed(1)} m), ` +
        `peak memory ${report.peakRssMb} MB`,
    );
    if (report.surveySkipped) {
      console.log(`[bake] survey skipped (spec unchanged)`);
    }
    if (report.tilesSkipped > 0) {
      console.log(`[bake] tiles: ${report.tilesGenerated} regenerated, ${report.tilesSkipped} unchanged (skipped)`);
    }
    spawn = report.spawn;
    console.log(`[bake] spawn point (${spawn.x}, ${spawn.z})${report.spawn.biome ? ` in ${report.spawn.biome}` : ""}`);
    const { minChunk, maxChunk } = worldBounds(spec);
    bounds = { minCx: minChunk, minCz: minChunk, maxCx: maxChunk, maxCz: maxChunk };
    // Entities are placed on the STORED terrain, exactly as the server reads it.
    tiles = new TerrainTileStore(dbPath);
    terrain = makeTileChunkSource(tiles, procgen);
  }

  // ---- entities: only the spawn area (the rest streams in later) ---------
  // Loaded exactly as the server's streamer loads chunks, then saved as
  // tick 0; the server adopts these chunks on boot.
  const scx = Math.floor(spawn.x / chunkSize);
  const scz = Math.floor(spawn.z / chunkSize);
  const area: Array<[number, number]> = [];
  for (let dz = -RADIUS; dz <= RADIUS; dz++) {
    for (let dx = -RADIUS; dx <= RADIUS; dx++) area.push([scx + dx, scz + dz]);
  }
  const sim = new SimWorld();
  // What grows (see world-populator): on a spec world by biome and water.
  const biomeMap = tiles?.getMap("biome") ?? null;
  const formationTiles = new FormationTileStore(dbPath);
  const populator = await makeWorldPopulator({
    worldSeed,
    chunkWorldSize: chunkSize,
    seaLevel: spec?.land.seaLevel,
    biomeAt: spec && biomeMap ? biomeAtFromMap(biomeMap, spec.biomes.map((b) => b.id)) : undefined,
    waterAt:
      spec && tiles
        ? (waterSurfaceFromMaps({ level: tiles.getMap("water_level"), water: tiles.getMap("water") }, spec.land.seaLevel) ?? undefined)
        : undefined,
    terrain: terrain,
    formationTiles: { store: formationTiles, terrainVersion: String(procgen.terrainVersion) },
    log: (l) => console.log(l),
  });
  // Formations (WFC-placed groups, see procgen/formation.ts): solved for the
  // whole world now, so the server only reads them.
  if (populator.bakeFormations) {
    const t0 = performance.now();
    const whole = spec ? worldBounds(spec) : null;
    const lo = whole ? { x: whole.minChunk, z: whole.minChunk } : { x: scx - RADIUS, z: scz - RADIUS };
    const hi = whole ? { x: whole.maxChunk, z: whole.maxChunk } : { x: scx + RADIUS, z: scz + RADIUS };
    let result = { tiles: 0, solved: 0 };
    let lastLog = t0;
    formationTiles.transaction(() => {
      result = (populator.bakeFormations as NonNullable<typeof populator.bakeFormations>)(lo, hi, (done, total) => {
        if (performance.now() - lastLog > 5000) {
          lastLog = performance.now();
          console.log(`[bake] formations: ${done}/${total} tiles`);
        }
      });
    });
    if (result.tiles > 0) console.log(`[bake] formations: ${result.tiles} tiles (${result.solved} solved) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  const chunkStore = new ChunkEntityStore(dbPath);
  const chunks = new ChunkStreamer({
    terrain,
    worldSeed,
    chunkWorldSize: chunkSize,
    store: chunkStore,
    populator,
    bounds,
    pinned: area,
  }).warm(sim);
  const scattered = sim.liveEntityCount - chunks;
  chunkStore.close();
  formationTiles.close();
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
    store.setMeta("spawn_point", JSON.stringify({ x: spawn.x, z: spawn.z }));
    store.setMeta("sea_level", String(spec.land.seaLevel));
    // Biome map values index this list (clients colour the ground by it).
    store.setMeta("world_biomes", JSON.stringify(spec.biomes.map((b) => b.id)));
    // Content-address the survey: an equal hash on re-bake means the survey
    // (maps + catalog) is already in the db and can be skipped.
    store.setMeta("survey_hash", report!.surveyHash);
  }
  store.close();
  if (!spec) {
    // Legacy small world: store the spawn area's heights as the world's tiles.
    const legacy = new TerrainTileStore(dbPath);
    legacy.putMany(
      area.map(([cx, cz]) => {
        const heights = new Float32Array(procgen.chunkSamples);
        procgen.generateChunk(worldSeed, cx, cz, 0, heights);
        return { cx, cz, heights };
      }),
    );
    legacy.close();
  }

  console.log(
    `[bake] seed=${worldSeed} ${spec ? `world "${spec.name}"` : `terrain=amp ${procgen.amplitude}/freq ${procgen.frequency} (v${procgen.terrainVersion})`} ` +
      `spawn chunks=${chunks} scattered=${scattered} entities=${sim.liveEntityCount} ` +
      `plan=${populator.planHash.slice(0, 12)}… ` +
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
  const shape = parseShape(process.env.MMO_BAKE_SHAPE ?? flag("shape"));
  const size = parseSizeChunks(process.env.MMO_BAKE_SIZE_CHUNKS ?? flag("size-chunks"));
  if (shape === undefined && size === undefined) return loadWorldSpec(file);
  const spec = loadWorldSpec(file);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  raw.land = { ...(raw.land as object), coast: { ...((raw.land as { coast?: object } | undefined)?.coast ?? {}), ...(shape ? { shape } : {}) } };
  if (shape === "continents") {
    // The default spec pins its one range where the 4 km island's land is; continents get a chain on each, placed on the land they have.
    const { center: _pinned, ...ranges } = (raw.ranges ?? {}) as Record<string, unknown>;
    // Wide landmasses have dry interiors; more rain keeps them green.
    const climate = (raw.climate ?? {}) as Record<string, unknown>;
    raw.climate = { ...climate, humidity: Math.max(Number(climate.humidity ?? 1), 1.4) };
    raw.ranges = { ...ranges, count: Math.max(Number(ranges.count ?? 1), parseWorldSpec({ ...raw, land: raw.land }).land.coast.continents) };
  }
  const want = size ?? (shape === "continents" ? Math.max(spec.sizeChunks, CONTINENT_MIN_CHUNKS) : spec.sizeChunks);
  if (want !== spec.sizeChunks) {
    // Keep the region grid dividing the world evenly.
    raw.sizeChunks = want;
    raw.regionsPerSide = [spec.regionsPerSide, 2, 1].find((r) => want % r === 0) ?? 1;
  }
  const out = parseWorldSpec(raw);
  const km = (out.sizeChunks * out.chunkWorldSize) / 1000;
  console.log(`[bake] shape ${out.land.coast.shape}${want !== spec.sizeChunks ? `, world grown to ${out.sizeChunks} chunks (${km} km a side)` : ""}`);
  // Other tools (terrain-tool, the editor) read the spec themselves: leave the one this world was baked from beside it.
  const derived = path.join(DATA_DIR, "world.spec.json");
  fs.writeFileSync(derived, JSON.stringify(raw, null, 2));
  console.log(`[bake] spec used saved to ${derived} (MMO_WORLD_SPEC=${derived} for tools that read the spec)`);
  return out;
}

main().catch((err) => {
  console.error(`[bake] failed: ${(err as Error).message}`);
  process.exit(1);
});
