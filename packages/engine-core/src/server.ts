/**
 * Production server entry (Phase 3): `npm run server`.
 *
 * Wires the full authoritative stack in one Node process:
 *   SimWorld + IntentSystem + IntegrateSystem + Jolt PhysicsSystem +
 *   Recast NavigationSystem, a procgen chunk baked into the navmesh
 *   tile registry at boot, SQLite persistence (save every 300 ticks +
 *   on SIGTERM/SIGINT), CSV auth, and the WebSocket gateway.
 *
 * The browser mirror client (apps/client) connects to this.
 *
 * Environment:
 *   MMO_PORT       WebSocket listen port (default 7777)
 *   MMO_DATA_DIR   server state dir: world.db, navmesh/, users.csv
 *                  (default ./data, relative to the process cwd)
 *   MMO_WORLD_SEED procgen world seed (default 1234)
 *   MMO_CHUNK_SIZE chunk world size in units (default 16)
 *   MMO_WORLD_RADIUS chunk radius around (0,0) loaded at boot (default 1 = 3x3)
 *   MMO_TERRAIN_AMPLITUDE  terrain height scale, world units (default 2)
 *   MMO_TERRAIN_FREQUENCY  terrain noise frequency, (0, 1] (default 0.02)
 *                  Must match the values the world was baked with.
 *
 * Region/world (slice A): when WORLD_URL is set (e.g.
 * http://localhost:7780), this instance registers as a region with the
 * world server, heartbeats off the tick loop, and reports snapshots.
 *   WORLD_URL          world server base URL (unset = standalone region)
 *   WORLD_API_KEY      bootstrap key matching the world's WORLD_API_KEY
 *   REGION_ID          this region's id (default "region-1")
 *   REGION_CHUNK_RANGE "x0,z0,x1,z1" owned chunk bounds (default "0,0,4096,4096")
 *   REGION_ENDPOINT    advertised gateway URL (default ws://localhost:<MMO_PORT>)
 *   REGION_CAPACITY    max entities for load reporting (default 1000)
 *
 * First run: create a login with `npm run seed:user` (MMO_DEV_PASSWORD=...
 * npm run seed:user -- <username>), then point the client at
 * ws://localhost:7777.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  Gateway,
  despawnSessionlessAvatars,
  SimWorld,
  IntentSystem,
  CharacterSystem,
  IntegrateSystem,
  PhysicsSystem,
  createJoltBackend,
  NavigationSystem,
  createNavigationBackend,
  bakeChunkTile,
  DEFAULT_BAKE_CONFIG,
  makeProcgenChunkSource,
  makeTileChunkSource,
  heightsFingerprint,
  createCachedChunkSource,
  terrainOptionsFromEnv,
  TerrainTileStore,
  SERVER_PID_FILE,
  spawnChunk,
  loadScatterContent,
  makeScatterBinding,
  scatterChunkToECS,
  SnapshotStore,
  installShutdownHook,
  NavmeshTileRegistry,
  CsvCredentialStore,
  makeDebugSource,
  WorldClient,
  WebrpcWorldTransport,
  type NavmeshTileKey,
} from "./index.js";

const PORT = Number(process.env.MMO_PORT ?? 7777);
const DATA_DIR = path.resolve(process.env.MMO_DATA_DIR ?? "./data");
const WORLD_SEED = BigInt(process.env.MMO_WORLD_SEED ?? 1234);
const CHUNK_SIZE = Number(process.env.MMO_CHUNK_SIZE ?? 16);
const SAVE_EVERY_TICKS = 300;
/** Chunk radius around (0,0) loaded at boot (1 = 3x3), matching bake:world. */
const WORLD_RADIUS = Number(process.env.MMO_WORLD_RADIUS ?? 1);
if (!Number.isInteger(WORLD_RADIUS) || WORLD_RADIUS < 0) {
  throw new Error(`MMO_WORLD_RADIUS must be a non-negative integer (got ${process.env.MMO_WORLD_RADIUS})`);
}

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // ---- persistence: restore the world if a snapshot exists --------------
  const store = new SnapshotStore({
    dbPath: path.join(DATA_DIR, "world.db"),
    saveEveryTicks: SAVE_EVERY_TICKS,
  });
  const sim = new SimWorld();
  const restoredTick = store.restoreInto(sim);
  const freshBoot = restoredTick == null;
  if (!freshBoot) {
    // Sessions don't survive a restart, so restored login avatars are
    // unreachable ghosts that would accumulate one per restart.
    const ghosts = despawnSessionlessAvatars(sim);
    if (ghosts > 0) console.log(`[server] despawned ${ghosts} sessionless avatar(s) from the snapshot`);
  }

  // ---- native systems ----------------------------------------------------
  const physics = new PhysicsSystem(createJoltBackend());
  const navBackend = createNavigationBackend({
    originX: 0,
    originZ: 0,
    tileWorldSize: CHUNK_SIZE,
    profiles: [{ id: 0, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9 }],
  });
  const navigation = new NavigationSystem({ backend: navBackend });

  // ---- procgen chunk + navmesh tile, baked at boot (never per tick) ------
  const terrain = makeProcgenChunkSource(terrainOptionsFromEnv());
  // The world heightmap is DATA once generated: stored tiles (baked or
  // sculpted in the editor) win; chunks without a tile — never baked, the
  // world beyond the edge — come from the generator.
  const tiles = new TerrainTileStore(path.join(DATA_DIR, "world.db"));
  const storedTiles = tiles.count();
  // One memoized source for every consumer (spawn, navmesh bake,
  // grounding, the network height channel): heights are read or generated
  // once per chunk instead of on every snapshot and reconnect.
  const procgen = createCachedChunkSource(makeTileChunkSource(tiles, terrain));
  const terrainVersion = String(terrain.terrainVersion);
  if (freshBoot) {
    store.setMeta("terrain_version", terrainVersion);
  } else if (storedTiles === 0) {
    // Legacy world (baked before tiles were stored): its scatter Y was
    // computed against the generator settings of the time. A different
    // setting restores trees floating or buried — say so loudly.
    const bakedWith = store.getMeta("terrain_version");
    if (bakedWith !== terrainVersion) {
      console.warn(
        `[server] WARNING: world.db was baked for terrain ${bakedWith ?? "(unrecorded)"}, ` +
          `but this server generates terrain ${terrainVersion} ` +
          `(amplitude ${terrain.amplitude}, frequency ${terrain.frequency}). ` +
          `Scatter will not sit on the ground. Rebake: npm run bake:world:force`,
      );
    }
  }
  const registry = new NavmeshTileRegistry({ dir: path.join(DATA_DIR, "navmesh") });
  // The (2R+1)^2 chunk area around the origin — the same area bake:world
  // produces, so a fresh boot (e.g. editor play mode) and a baked world
  // look alike, and the player spawn grid (-14..14) is on rendered ground.
  const area: Array<[number, number]> = [];
  for (let cz = -WORLD_RADIUS; cz <= WORLD_RADIUS; cz++) {
    for (let cx = -WORLD_RADIUS; cx <= WORLD_RADIUS; cx++) area.push([cx, cz]);
  }
  if (storedTiles === 0 && (freshBoot || store.getMeta("terrain_version") === terrainVersion)) {
    // Freeze the loaded area's terrain into tiles (fresh worlds, and legacy
    // worlds whose generator settings still match): from here on it is
    // editable data, not a formula.
    tiles.putMany(
      area.map(([cx, cz]) => {
        const heights = new Float32Array(procgen.chunkSamples);
        procgen.generateChunk(WORLD_SEED, cx, cz, 0, heights);
        return { cx, cz, heights };
      }),
    );
  }
  if (freshBoot) {
    // PCG scatter (slice 4): chunk-load-time spawn of environment
    // entities from the cooked scatter plan. Runs only when the chunk
    // entity is spawned (fresh boot) — never on reboot restore — so
    // scatter output is never duplicated. Entities persist through the
    // normal snapshot path like everything else.
    const scatterContent = loadScatterContent();
    const scatterBinding = makeScatterBinding();
    let scattered = 0;
    for (const [cx, cz] of area) {
      const { heights } = spawnChunk(sim, procgen, WORLD_SEED, cx, cz, 0);
      scattered += scatterChunkToECS(sim, scatterBinding, scatterContent, {
        worldSeed: WORLD_SEED,
        cx,
        cz,
        heights,
        chunkWorldSize: CHUNK_SIZE,
      }).length;
    }
    console.log(
      `[scatter] ${area.length} chunk(s): ${scattered} entities ` +
        `(plan ${scatterContent.planHash.slice(0, 12)}…)`,
    );
  }
  // Navmesh tile per chunk. The registry is the tile source of truth:
  // bake only when missing, then load from the stored (content-addressed)
  // blob, never re-bake.
  const loadedTileKeys: NavmeshTileKey[] = [];
  let navPolys = 0;
  for (const [cx, cz] of area) {
    const baked = bakeChunkTile(
      {
        backend: navBackend,
        source: procgen,
        seed: WORLD_SEED,
        chunkWorldSize: CHUNK_SIZE,
        bakeConfig: { ...DEFAULT_BAKE_CONFIG },
      },
      cx,
      cz,
    );
    navPolys += baked.stats.polyCount;
    // Keyed to this chunk's exact heights: a sculpted chunk gets a new key
    // (fresh bake); untouched chunks keep reusing their cached tile.
    const chunkHeights = new Float32Array(procgen.chunkSamples);
    procgen.generateChunk(WORLD_SEED, cx, cz, 0, chunkHeights);
    const tileKey: NavmeshTileKey = {
      worldSeed: WORLD_SEED.toString(),
      chunkX: cx,
      chunkZ: cz,
      terrainVersion: heightsFingerprint(chunkHeights),
      agentProfile: 0,
      bakeConfigHash: baked.bakeConfigHash,
    };
    if (!registry.lookup(tileKey)) registry.register(tileKey, baked.blob);
    const tileBlob = fs.readFileSync(
      registry.tilePath(registry.lookup(tileKey)!.blobSha256),
    );
    navBackend.loadTiles([new Uint8Array(tileBlob)]);
    loadedTileKeys.push(tileKey);
  }

  // ---- auth + gateway ----------------------------------------------------
  const credentialStore = new CsvCredentialStore(
    path.join(DATA_DIR, "users.csv"),
  );
  // The debug overlay draws what pathfinding can actually use: the tiles
  // currently LOADED into the nav backend (tracked above at load time),
  // not every key the registry happens to know about.
  const tileBounds = (
    k: NavmeshTileKey,
  ): [number, number, number, number] => [
    k.chunkX * CHUNK_SIZE,
    k.chunkZ * CHUNK_SIZE,
    (k.chunkX + 1) * CHUNK_SIZE,
    (k.chunkZ + 1) * CHUNK_SIZE,
  ];
  const gw = new Gateway({
    port: PORT,
    world: sim,
    systems: [
      new IntentSystem(),
      new IntegrateSystem(),
      // Kinematic character control (gravity/jump/grounding) corrects
      // the integrated Y in the same tick, before snapshot collection.
      new CharacterSystem({ chunkSource: procgen, worldSeed: WORLD_SEED }),
      physics,
      navigation,
    ],
    credentialStore,
    startTick: freshBoot ? 1 : restoredTick! + 1,
    // Terrain-height channel (slice 4.1): the gateway attaches authoritative
    // 16x16 heights to chunk rows on network snapshots/deltas. The
    // persistence path never sees them (SnapshotStore collects separately).
    chunkSource: procgen,
    // Editor-only debug (protocol v3, 0x0a): read-only answers composed
    // from the live sim. The gateway only validates/authenticates and
    // encodes — all sim knowledge lives behind this interface.
    debugSource: makeDebugSource({
      world: sim,
      navigation,
      loadedTileBounds: () => loadedTileKeys.map(tileBounds),
    }),
  });

  // ---- periodic persistence (every SAVE_EVERY_TICKS server ticks) --------
  let nextSaveTick =
    (Math.floor(gw.serverTick / SAVE_EVERY_TICKS) + 1) * SAVE_EVERY_TICKS;

  // ---- world server registration (region) -------------------------------
  // Runs entirely off the tick loop: register -> heartbeat timer ->
  // snapshot reports. A slow or dead world server must never stall the sim.
  const WORLD_URL = process.env.WORLD_URL;
  const REGION_ID = process.env.REGION_ID ?? "region-1";
  const REGION_CAPACITY = Number(process.env.REGION_CAPACITY ?? 1000);
  let worldClient: WorldClient | null = null;
  if (WORLD_URL) {
    const parts = (process.env.REGION_CHUNK_RANGE ?? "0,0,4096,4096")
      .split(",")
      .map(Number);
    worldClient = new WorldClient({
      transport: new WebrpcWorldTransport(WORLD_URL),
      regionId: REGION_ID,
      chunkRange: { x0: parts[0], z0: parts[1], x1: parts[2], z1: parts[3] },
      endpoint:
        process.env.REGION_ENDPOINT ?? `ws://localhost:${PORT}`,
      capacity: REGION_CAPACITY,
      apiKey: process.env.WORLD_API_KEY ?? "",
      getStats: () => ({
        load: sim.liveEntityCount / REGION_CAPACITY,
        // TODO(slice D): real tick timing from the harness.
        tickJitterMs: 0,
        entityCount: sim.liveEntityCount,
      }),
      onError: (err, ctx) =>
        console.warn(`[server] world ${ctx}: ${(err as Error).message}`),
    });
    await worldClient.start();
    if (worldClient.registered) {
      console.log(`[server] registered with world at ${WORLD_URL} as ${REGION_ID}`);
    } else {
      console.warn(`[server] world registration failed; running standalone`);
    }
  }

  const saveTimer = setInterval(() => {
    if (gw.serverTick >= nextSaveTick) {
      const result = store.saveWorld(gw.serverTick, sim);
      console.log(
        `[server] saved tick ${result.tick} (${result.entityCount} entities, ${result.bytes} B, ${result.ms.toFixed(1)} ms)`,
      );
      if (worldClient?.registered) {
        const digest = crypto
          .createHash("sha256")
          .update(`${gw.serverTick}:${sim.liveEntityCount}`)
          .digest("hex");
        void worldClient.reportSnapshot(
          gw.serverTick,
          sim.liveEntityCount,
          digest,
        );
      }
      nextSaveTick += SAVE_EVERY_TICKS;
    }
  }, 1000);
  saveTimer.unref();

  installShutdownHook(store, () => ({ tick: gw.serverTick, sim }), {
    onSaved: (result, signal) => {
      console.log(`[server] shutdown save on ${signal}: tick ${result.tick}`);
      // Best-effort deregister; the world's stale-region reaper is the
      // backstop if this doesn't land before exit.
      void worldClient?.stop();
    },
  });

  const port = await gw.listen();
  gw.startTicking();
  // "A server owns this world" marker: offline tools (terrain save) refuse
  // to edit world.db under a running server, whose next periodic save
  // would silently overwrite the edit. Removed on exit; a stale file from
  // a crash is ignored because its pid is no longer alive.
  const pidFile = path.join(DATA_DIR, SERVER_PID_FILE);
  fs.writeFileSync(pidFile, String(process.pid));
  process.on("exit", () => {
    try {
      if (fs.readFileSync(pidFile, "utf8") === String(process.pid)) fs.unlinkSync(pidFile);
    } catch {
      /* already gone */
    }
  });
  console.log(`[server] listening on ws://0.0.0.0:${port}`);
  console.log(
    `[server] ${freshBoot ? "fresh boot" : `restored at tick ${restoredTick}`} | ` +
      `seed ${WORLD_SEED} | chunk ${CHUNK_SIZE}u | ` +
      `terrain ${storedTiles > 0 ? `${storedTiles} stored tile(s)` : `amp ${terrain.amplitude} freq ${terrain.frequency} (v${terrainVersion})`} | ` +
      `navmesh ${loadedTileKeys.length} tile(s), ${navPolys} polys | data ${DATA_DIR}`,
  );
  console.log(
    `[server] no users yet? create one in the client ("Create account" tab), or: MMO_DEV_PASSWORD=<8-128 chars> npm run seed:user --workspace=@mmo-engine/engine-core -- <name>`,
  );
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
