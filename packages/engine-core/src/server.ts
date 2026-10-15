/**
 * Production server entry (Phase 3): `npm run server`.
 *
 * Wires the full authoritative stack in one Node process:
 *   SimWorld + ChunkStreamer (chunks, scatter, and navmesh tiles load
 *   around players and unload behind them) + IntentSystem +
 *   IntegrateSystem + PropCollisionSystem + Jolt PhysicsSystem + Recast NavigationSystem,
 *   SQLite persistence (save every 300 ticks + on SIGTERM/SIGINT), CSV
 *   auth, and the WebSocket gateway.
 *
 * The browser mirror client (apps/client) connects to this.
 *
 * Environment:
 *   MMO_PORT       WebSocket listen port (default 7777)
 *   MMO_DATA_DIR   server state dir: world.db, navmesh/, users.csv,
 *                  characters.db (default ./data, relative to the process cwd)
 *   MMO_CHARACTER_CATALOG the modular part catalog new characters are checked
 *                  against (default: the converted pack's catalog.json under
 *                  the repo's assets/; without it looks are checked
 *                  structurally only)
 *   MMO_WORLD_SEED procgen world seed (default 1234; a world baked from a
 *                  world spec uses the seed recorded at bake time)
 *   MMO_CHUNK_SIZE chunk world size in units (default 16)
 *   MMO_WORLD_RADIUS spawn-area chunk radius, always loaded (default 1 =
 *                  3x3 around the spawn point; a legacy world IS this area)
 *   MMO_STREAM_RADIUS chunks loaded around each player (default 8 = 17x17,
 *                  272 m: past the client's fog)
 *   MMO_PCG_ASSETS PCG asset library dir (default: the repo's content/pcg)
 *   MMO_RULES      game rules dir (default: the repo's content/rules); a
 *                  bad rules file stops the server with every problem named
 *   MMO_COMBAT     combat moves file (default: the repo's content/combat/moves.json)
 *   MMO_SCATTER    what grows on new chunks: "ecology" (natural placement of
 *                  the Synty nature set, content/ecology/wilds.ecology.json)
 *                  or "pcg" (the PCG forest graph with PICG trees). Default:
 *                  ecology when the art is on this machine, else pcg.
 *   MMO_ECOLOGY    an ecology plan file (default: content/ecology/wilds.ecology.json)
 *   MMO_QUESTS     quest and dialog content dir (default: the repo's
 *                  content/quests); quest logs live in <data>/quests.db
 *   MMO_DUNGEONS   dungeon instance rules and entrances dir (default: the
 *                  repo's content/dungeons); layouts come from the pool at
 *                  <data>/dungeons (npm run dungeon:bake), runs are kept in
 *                  <data>/instances.db
 *   MMO_INSTANCE_HOST host clients reach instances at (default localhost;
 *                  each instance listens on its own free port)
 *   MMO_MODULES    the enabled module set document (default: content/modules.json;
 *                  modules/<name>/module.json). `core` is always on. The tick's
 *                  systems are core's plus those the enabled modules add, ordered
 *                  by their after/before; a bad set stops the server with every
 *                  problem named (EA9)
 *   MMO_BIOMES     the biome registry: per-biome scatter multipliers and
 *                  creature tables (default: content/biomes.json)
 *   MMO_WILD_CREATURES=1 spawns the registry's packs as chunks load (on a
 *                  baked world with biomes; default off). Only kinds with
 *                  creature rules spawn.
 *   MMO_SCENE      a scene (content/scenes/<name>.scene.json) whose nodes spawn at boot as
 *                  creatures, props, items and quest posts (roadmap EA6); MMO_SCENES
 *                  overrides the scenes dir, MMO_PREFABS the prefab files (content/prefabs)
 *   MMO_SPECIES    the species overlay file (default content/species/species.json),
 *                  merged over the built-in roster; a bad file stops the boot
 *   MMO_CRAFTING   the crafting rules (default content/crafting/recipes.json); a bad file
 *                  stops the boot
 *   MMO_BOTS       computer-driven characters near the spawn point (default 0):
 *                  sparring pairs and wanderers, with random looks
 *   MMO_BOTS_HOME  "x,z" where they gather (default: beside the spawn point)
 *   MMO_BOTS_RADIUS how far from home they roam, metres (default 18)
 *   MMO_SPAWN_OVERRIDE "x,z" player spawn point, overriding the world's stored
 *                  spawn_point (the editor's Play menu "Start from")
 *   MMO_PLAYER_ABILITIES what new players can do: "swim" (default), or
 *                  "swim,fly" (flight is for expansions; "none" = walk only)
 *   MMO_USERS_CSV  accounts file (default $MMO_DATA_DIR/users.csv); the editor
 *                  points play sessions at a scratch file
 *   MMO_ADMINS     comma-separated admin usernames for the admin console
 *                  (protocol 0x10, roadmap A1; default empty = nobody)
 *   MMO_DEV_SERVER=1 makes every account an admin (development servers
 *                  only — never on a public deployment)
 *   MMO_DAY_SECONDS real seconds in one game day (default 2400 = 40 min;
 *                  0 = no day cycle: clients keep a fixed midday)
 *   MMO_DAY_OFFSET time of day at tick 0, 0..1 (0 midnight, 0.25 dawn,
 *                  0.5 noon; default 0.35, mid-morning)
 *   MMO_TERRAIN_AMPLITUDE  terrain height scale, world units (default 2)
 *   MMO_TERRAIN_FREQUENCY  terrain noise frequency, (0, 1] (default 0.02)
 *                  Must match the values the world was baked with.
 *
 *   CORE_CHANNEL_PORT the edge's internal channel, loopback only (default
 *                  4000; see docs/EDGE-CORE-SPLIT.md). Session tokens are
 *                  kept in world.db's sessions table.
 *
 * Region/world (slice A): when WORLD_URL is set (e.g.
 * http://localhost:7780), this instance registers as a region with the
 * world server, heartbeats off the tick loop, and reports snapshots.
 *   WORLD_URL          world server base URL (unset = standalone region)
 *   WORLD_API_KEY      bootstrap key matching the world's WORLD_API_KEY
 *   REGION_ID          this region's id (default "region-1")
 *   REGION_CHUNK_RANGE "x0,z0,x1,z1" owned chunk bounds (default "0,0,4096,4096";
 *                      when set, the streamer loads only inside it)
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
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Gateway,
  despawnSessionlessAvatars,
  SimWorld,
  IntentSystem,
  CharacterSystem,
  IntegrateSystem,
  PropCollisionSystem,
  PhysicsSystem,
  ColliderSystem,
  createJoltBackend,
  NavigationSystem,
  createNavigationBackend,
  makeProcgenChunkSource,
  makeTileChunkSource,
  createCachedChunkSource,
  terrainOptionsFromEnv,
  TerrainTileStore,
  SERVER_PID_FILE,
  ChunkEntityStore,
  ChunkNavmesh,
  ChunkStreamer,
  SnapshotStore,
  installShutdownHook,
  NavmeshTileRegistry,
  CsvCredentialStore,
  makeDebugSource,
  WorldClient,
  WebrpcWorldTransport,
  MigrationCoordinator,
  waterSurfaceFromMaps,
  type ChunkBounds,
  SqlitePartyStore,
  SqliteSocialStore,
} from "./index.js";
import { Ability, type DayClock } from "@mmo-engine/protocol";
import { worldInfoFor } from "./terrain/world-info.js";
import { startPcgService } from "./pcg/boot.js";
import { healthHttpHandler } from "./net/health.js";
import { clampSpawn, parseSpawnOverride } from "./spawn-override.js";
import { armourFactor, RulesError } from "@mmo-engine/rules";
import { DEFAULT_LADDER } from "@mmo-engine/compose";
import { loadGameRules, type GameRules } from "./rules/boot.js";
import { assembleServerSystems } from "./modules.js";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Load the chat module's rule bundle (complete-modularity slice 1).
 * Returns undefined when the module is absent/disabled — the gateway
 * falls back to its built-in rules.
 */
async function loadChatRules(): Promise<import("./net/gateway.js").ChatRules | undefined> {
  try {
    const entry = path.join(REPO_ROOT, "modules", "chat", "server.js");
    if (!fs.existsSync(entry)) return undefined;
    const mod = await import(pathToFileURL(entry).href);
    return mod as import("./net/gateway.js").ChatRules;
  } catch (err) {
    console.warn(`[modules] chat module failed to load, using built-in rules: ${(err as Error).message}`);
    return undefined;
  }
}
import { HooksDelegate, RulesReloader } from "./rules/reload.js";
import { type CombatDamage, type CombatSkills, type Weapon } from "./combat.js";
import { type BodySystem } from "./body.js";
import { type MagicSystem } from "./magic.js";
import { WalletSystem } from "./economy/wallet.js";
import { SqliteWalletStore } from "./economy/wallet-store.js";
import { TradeSystem } from "./economy/trade.js";
import { VendorSystem } from "./economy/vendor.js";
import { AuctionSystem } from "./economy/auction.js";
import { hasComponent } from "bitecs";
import { CharacterRef, God, Health } from "./components.js";
import { SkillSheet } from "./stats/mastery.js";
import { DEFAULT_QUEST_DIR } from "./quests/content.js";
import { DEFAULT_DUNGEON_CONTENT } from "./dungeons/content.js";
import { SqliteInstanceResultStore, flushInstanceResults } from "./dungeons/results.js";
import { DEFAULT_PREFABS_DIR, DEFAULT_SCENES_DIR, loadPrefabs, loadSceneFile, spawnSceneOnBoot } from "./scene-spawn.js";
import { editedPack, loadServerRoster, type ServerRoster } from "./species-roster.js";
import { loadCraftingRules, type CraftingRules } from "@mmo-engine/crafting";
import { loadScatterContent } from "./procgen/scatter-spawn.js";
import { NavObstacleSystem } from "./navigation/obstacle-system.js";
import { TILE_CACHE_SETTINGS } from "./navigation/chunk-baker.js";
import { SqliteGuildStore } from "./guild-store.js";
import { loadCharacterCatalog, SqliteCharacterStore } from "./characters/index.js";
import { makeWorldPopulator } from "./procgen/world-populator.js";
import { FormationTileStore } from "./persist/formation-tiles.js";
import { ItemLedger } from "./persist/item-ledger.js";
import { biomeLookup } from "./terrain/biome-lookup.js";
import { checkBiomeRegistry, DEFAULT_BIOME_REGISTRY, loadBiomeRegistry } from "./procgen/biome-registry.js";
import { WildCreatures } from "./procgen/wild-creatures.js";
import { ecologySeed32 } from "./procgen/ecology.js";
import { lineDef } from "./items/index.js";
import { SqliteSessionStore } from "./auth/index.js";
import { coreChannelPort, startCoreChannel } from "./channel-server.js";
import { loadCombatContent } from "./combat-content.js";

/** MMO_PLAYER_ABILITIES ("swim", "swim,fly", "none") as protocol Ability bits. */
function playerAbilitiesFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return Ability.Swim;
  let bits = 0;
  for (const word of value.split(",").map((w) => w.trim().toLowerCase())) {
    if (word === "swim") bits |= Ability.Swim;
    else if (word === "fly") bits |= Ability.Fly;
    else if (word !== "none") throw new Error(`MMO_PLAYER_ABILITIES: unknown ability "${word}" (want swim, fly, or none)`);
  }
  return bits;
}

/** MMO_DAY_SECONDS / MMO_DAY_OFFSET as the welcome's day clock (null: no day cycle). */
function dayClockFromEnv(seconds: string | undefined, offset: string | undefined): DayClock | null {
  const s = Number(seconds ?? 2400);
  const o = Number(offset ?? 0.35);
  if (!Number.isFinite(s) || s < 0) throw new Error(`MMO_DAY_SECONDS must be a number of seconds >= 0 (got ${seconds})`);
  if (!Number.isFinite(o) || o < 0 || o >= 1) throw new Error(`MMO_DAY_OFFSET must be in [0, 1) (got ${offset})`);
  return s === 0 ? null : { seconds: s, offset: o };
}

function abilityNames(bits: number): string {
  const names = [bits & Ability.Swim ? "swim" : "", bits & Ability.Fly ? "fly" : ""].filter(Boolean);
  return names.length > 0 ? names.join(", ") : "only walk";
}

const PORT = Number(process.env.MMO_PORT ?? 7777);
const DATA_DIR = path.resolve(process.env.MMO_DATA_DIR ?? "./data");
const WORLD_SEED = BigInt(process.env.MMO_WORLD_SEED ?? 1234);
const CHUNK_SIZE = Number(process.env.MMO_CHUNK_SIZE ?? 16);
const SAVE_EVERY_TICKS = 300;
/** Spawn-area chunk radius, always loaded (1 = 3x3), matching bake:world. */
const WORLD_RADIUS = Number(process.env.MMO_WORLD_RADIUS ?? 1);
if (!Number.isInteger(WORLD_RADIUS) || WORLD_RADIUS < 0) {
  throw new Error(`MMO_WORLD_RADIUS must be a non-negative integer (got ${process.env.MMO_WORLD_RADIUS})`);
}
/** Chunks loaded around each player (Chebyshev radius). */
const STREAM_RADIUS = Number(process.env.MMO_STREAM_RADIUS ?? 8);
if (!Number.isInteger(STREAM_RADIUS) || STREAM_RADIUS < 0) {
  throw new Error(`MMO_STREAM_RADIUS must be a non-negative integer (got ${process.env.MMO_STREAM_RADIUS})`);
}

async function main(): Promise<void> {
  // ---- rules first: a bad rules file stops us before the world loads ----
  let game: GameRules;
  try {
    game = loadGameRules(process.env.MMO_RULES || undefined);
  } catch (err) {
    if (err instanceof RulesError) {
      console.error(`[server] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`[server] ${game.summary}`);
  // Authored data beyond the rules: the species roster and the crafting rules.
  let speciesRoster: ServerRoster;
  let crafting: CraftingRules;
  try {
    speciesRoster = loadServerRoster();
    crafting = loadCraftingRules(process.env.MMO_CRAFTING || undefined);
  } catch (err) {
    console.error(`[server] ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`[${speciesRoster.summary}]`);
  console.log(`[crafting: ${Object.keys(crafting.refining).length} refining recipe(s), ${Object.keys(crafting.reagents).length} element reagent(s)]`);
  // The combat moves (content/combat/moves.json, MMO_COMBAT): timing, chaining and travel the fight runs on.
  const combatLine = loadCombatContent(process.env.MMO_COMBAT || undefined);
  if (combatLine) console.log(`[server] ${combatLine}`);

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // ---- persistence: restore the world if a snapshot exists --------------
  const store = new SnapshotStore({
    dbPath: path.join(DATA_DIR, "world.db"),
    saveEveryTicks: SAVE_EVERY_TICKS,
  });
  // A world baked from a spec carries its own seed: scatter, navmesh keys,
  // and anything generated later must agree with its baked terrain.
  const bakedSeed = store.getMeta("world_seed");
  const worldSeed = bakedSeed !== null ? BigInt(bakedSeed) : WORLD_SEED;
  if (bakedSeed !== null && process.env.MMO_WORLD_SEED !== undefined && worldSeed !== WORLD_SEED) {
    console.warn(`[server] MMO_WORLD_SEED=${WORLD_SEED} ignored: this world was baked with seed ${worldSeed}`);
  }
  const sim = new SimWorld({ stats: game.rules.stats });
  const restoredTick = store.restoreInto(sim);
  const freshBoot = restoredTick == null;
  if (!freshBoot) {
    // Sessions don't survive a restart, so restored login avatars are
    // unreachable ghosts that would accumulate one per restart.
    const ghosts = despawnSessionlessAvatars(sim);
    if (ghosts > 0) console.log(`[server] despawned ${ghosts} sessionless avatar(s) from the snapshot`);
  }

  // Physics domain (slice 8): the physics module builds Jolt, navmesh,
  // obstacles, and the collision/integration systems from this config.
  // See modules/physics/server.js. The nav backend is shared with the
  // creatures module via ctx.shared (creatures depends on physics).
  const physicsConfig = {
    chunkSize: CHUNK_SIZE,
    tileCacheSettings: TILE_CACHE_SETTINGS,
    createChunkNavmesh: (navBackend: any, obstacles: any) => new ChunkNavmesh({
      backend: navBackend,
      registry,
      registryDir: navmeshDir,
      source: procgen,
      seed: worldSeed,
      chunkWorldSize: CHUNK_SIZE,
      worker: true,
      onLoaded: (cx, cz) => obstacles.tileLoaded(cx, cz),
    }),
    onNavBackend: (navBackend: any, obstacles: any, chunkNavmesh: any) => {
      navBackendRef = navBackend;
      obstaclesRef = obstacles;
      chunkNavmeshRef = chunkNavmesh;
    },
  };

  // ---- terrain ---------------------------------------------------------------
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
  const navmeshDir = path.join(DATA_DIR, "navmesh");
  const registry = new NavmeshTileRegistry({ dir: navmeshDir });

  // ---- world extent and spawn --------------------------------------------
  // A baked world records its chunk range and spawn point. A legacy world
  // is just the spawn area around the origin.
  const spawnMeta = store.getMeta("spawn_point");
  const storedSpawn = spawnMeta ? (JSON.parse(spawnMeta) as { x: number; z: number }) : { x: 0, z: 0 };
  // The editor's play mode overrides the spawn via MMO_SPAWN_OVERRIDE="x,z"
  // (Play menu "Start from"). Malformed values fall back to the stored point.
  // Clamped into a baked world's chunk range, so it cannot land off the world.
  const spawnOverride = parseSpawnOverride(process.env.MMO_SPAWN_OVERRIDE);
  const boundsMeta = store.getMeta("world_bounds");
  const bakedRange = boundsMeta ? (JSON.parse(boundsMeta) as { minChunk: number; maxChunk: number }) : null;
  const spawn = spawnOverride
    ? bakedRange
      ? clampSpawn(spawnOverride, bakedRange.minChunk, bakedRange.maxChunk, CHUNK_SIZE)
      : spawnOverride
    : storedSpawn;
  const scx = Math.floor(spawn.x / CHUNK_SIZE);
  const scz = Math.floor(spawn.z / CHUNK_SIZE);
  const area: Array<[number, number]> = [];
  for (let dz = -WORLD_RADIUS; dz <= WORLD_RADIUS; dz++) {
    for (let dx = -WORLD_RADIUS; dx <= WORLD_RADIUS; dx++) area.push([scx + dx, scz + dz]);
  }
  let bounds: ChunkBounds;
  if (bakedRange) {
    const { minChunk, maxChunk } = bakedRange;
    bounds = { minCx: minChunk, minCz: minChunk, maxCx: maxChunk, maxCz: maxChunk };
  } else {
    bounds = { minCx: scx - WORLD_RADIUS, minCz: scz - WORLD_RADIUS, maxCx: scx + WORLD_RADIUS, maxCz: scz + WORLD_RADIUS };
  }
  if (process.env.REGION_CHUNK_RANGE) {
    // A region streams only the chunks it owns.
    const [x0, z0, x1, z1] = process.env.REGION_CHUNK_RANGE.split(",").map(Number);
    bounds = {
      minCx: Math.max(bounds.minCx, x0),
      minCz: Math.max(bounds.minCz, z0),
      maxCx: Math.min(bounds.maxCx, x1),
      maxCz: Math.min(bounds.maxCz, z1),
    };
  }

  if (storedTiles === 0 && (freshBoot || store.getMeta("terrain_version") === terrainVersion)) {
    // Freeze the spawn area's terrain into tiles (fresh worlds, and legacy
    // worlds whose generator settings still match): from here on it is
    // editable data, not a formula.
    tiles.putMany(
      area.map(([cx, cz]) => {
        const heights = new Float32Array(procgen.chunkSamples);
        procgen.generateChunk(worldSeed, cx, cz, 0, heights);
        return { cx, cz, heights };
      }),
    );
  }

  // ---- streaming ---------------------------------------------------------
  // Chunks (terrain entity + scatter + navmesh tile) load around players
  // and unload behind them; unloaded chunks' entities live in world.db
  // (ChunkEntityStore) and come back exactly as they were left. The spawn
  // area stays loaded. Restored chunks are adopted, never loaded twice.
  // Chunk navmesh (slice 8): created by the physics module via
  // physicsConfig.createChunkNavmesh; see onNavBackend below.
  let navBackendRef: any = null;
  let obstaclesRef: any = null;
  let chunkNavmeshRef: any = null;
  let physicsRef: { terrainColliders(s: number): (...a: unknown[]) => unknown } | null = null;
  // Unload passes write rows on the tick thread. The snapshot store's
  // background worker already checkpoints world.db after every save, so
  // this connection leaves checkpoints (and their fsync) to it.
  const chunkStore = new ChunkEntityStore(path.join(DATA_DIR, "world.db"), { autoCheckpoint: false });
  const formationTiles = new FormationTileStore(path.join(DATA_DIR, "world.db"), { autoCheckpoint: false });
  // Every item change, appended here and written each second (roadmap P2a).
  const itemLedger = new ItemLedger(path.join(DATA_DIR, "world.db"), { autoCheckpoint: false });
  // Baked worlds have a sea: nothing is scattered below it.
  const seaLevelMeta = store.getMeta("sea_level");
  // Baked worlds have water: swimming happens against its surface, and
  // shorelines grow reeds.
  const water =
    seaLevelMeta === null
      ? null
      : waterSurfaceFromMaps({ level: tiles.getMap("water_level"), water: tiles.getMap("water") }, Number(seaLevelMeta));
  // What each biome holds: scatter multipliers and creature tables.
  const biomesFile = process.env.MMO_BIOMES || DEFAULT_BIOME_REGISTRY;
  const { registry: biomes } = loadBiomeRegistry(biomesFile);
  const biomeAt = biomeLookup(store, tiles);
  const worldBiomes = store.getMeta("world_biomes");
  if (worldBiomes) {
    const kinds = [...Object.keys(game.rules.creatures.creatures), ...Object.keys(speciesRoster.roster)];
    for (const p of checkBiomeRegistry(biomes, { worldBiomes: JSON.parse(worldBiomes) as string[], kinds })) console.warn(`[biomes] ${p} (${biomesFile})`);
  }
  // What grows on new chunks (see world-populator: ecology or PCG).
  const populator = await makeWorldPopulator({
    worldSeed,
    chunkWorldSize: CHUNK_SIZE,
    seaLevel: seaLevelMeta === null ? undefined : Number(seaLevelMeta),
    biomeAt: biomeAt ?? undefined,
    biomes,
    waterAt: water ?? undefined,
    terrain: procgen,
    // Formation tiles the bake solved (any it didn't are solved on demand and stored).
    formationTiles: { store: formationTiles, terrainVersion },
    log: (l) => console.log(l),
  });
  const streamer = new ChunkStreamer({
    terrain: procgen,
    worldSeed,
    chunkWorldSize: CHUNK_SIZE,
    store: chunkStore,
    populator,
    navmesh: chunkNavmeshRef,
    // Each loaded chunk is static ground for physics bodies. The hook is
    // lazy (physics assembles after the streamer is built) but must be
    // the ChunkColliderHook object shape ({add, remove}) — an earlier
    // revision wrapped it as a bare function, which crashed warm() with
    // "colliders?.add is not a function".
    colliders: ((() => {
      type Hook = { add(cx: number, cz: number, heights: Float32Array): void; remove(cx: number, cz: number): void };
      let hook: Hook | null = null;
      const get = (): Hook => {
        if (hook) return hook;
        if (!physicsRef) throw new Error("physics not yet assembled");
        // physicsRef is loosely typed (see its declaration); the runtime
        // value is the {add, remove} hook from PhysicsSystem.terrainColliders.
        hook = physicsRef.terrainColliders(CHUNK_SIZE) as unknown as Hook;
        return hook;
      };
      return {
        add: (cx: number, cz: number, heights: Float32Array) => get().add(cx, cz, heights),
        remove: (cx: number, cz: number) => get().remove(cx, cz),
      };
    })() as import("./streaming/chunk-streamer.js").ChunkColliderHook),
    bounds,
    pinned: area,
    loadRadius: STREAM_RADIUS,
  });
  // Streamer warm/adopt runs after assembly (below): it registers terrain
  // colliders, which need the physics module's terrainColliders hook.

  // ---- auth + gateway ----------------------------------------------------
  const credentialStore = new CsvCredentialStore(
    process.env.MMO_USERS_CSV ?? path.join(DATA_DIR, "users.csv"),
  );
  const characterStore = new SqliteCharacterStore(path.join(DATA_DIR, "characters.db"));
  const guildStore = new SqliteGuildStore(path.join(DATA_DIR, "guilds.db"));
  const socialStore = new SqliteSocialStore(path.join(DATA_DIR, "social.db"));
  const partyStore = new SqlitePartyStore(path.join(DATA_DIR, "parties.db"));
  // The licensed modular pack is only on machines that have the art
  // (assets/ is never committed): elsewhere looks are checked structurally.
  const catalogFile =
    process.env.MMO_CHARACTER_CATALOG ||
    fileURLToPath(new URL("../../../../assets/models/glb/modular-fantasy-hero/Rigged/catalog.json", import.meta.url));
  const characterCatalog = loadCharacterCatalog(catalogFile);
  console.log(
    characterCatalog
      ? `[characters] ${characterCatalog.parts.length} modular parts (${catalogFile})`
      : `[characters] no part catalog at ${catalogFile}: looks are checked structurally`,
  );
  // Kinematic character control (gravity/jump/grounding) corrects the
  // integrated Y in the same tick, before snapshot collection. Players are
  // held inside the world's edge.
  const playerAbilities = playerAbilitiesFromEnv(process.env.MMO_PLAYER_ABILITIES);
  const dayClock = dayClockFromEnv(process.env.MMO_DAY_SECONDS, process.env.MMO_DAY_OFFSET);
  // The body system is made below with the hooks; hard landings reach it through this.
  let bodyRef: BodySystem | null = null;
  let magicRef: import("./magic.js").MagicSystem | null = null;
  // Slice 6: creatures domain comes from the creatures module.
  let creaturesRef: {
    creatures: import("./creatures.js").CreatureSystem;
    bots: import("./bots.js").BotSystem | null;
    crowd: import("./navigation/crowd-system.js").CrowdSystem | null;
  } | null = null;
  const creaturesOf = () => {
    if (!creaturesRef) throw new Error("creatures not yet assembled");
    return creaturesRef.creatures;
  };
  // Slice 7: character domain comes from the character module.
  let characterRef: {
    character: import("./index.js").CharacterSystem;
    mastery: import("./stats/mastery-system.js").MasterySystem;
  } | null = null;
  const characterOf = () => {
    if (!characterRef) throw new Error("character not yet assembled");
    return characterRef.character;
  };
  const masteryOf = () => {
    if (!characterRef) throw new Error("character not yet assembled");
    return characterRef.mastery;
  };
  // Character domain (slice 7): the character module builds character,
  // animation, mastery, and stats from this config during assembly.
  // See modules/character/server.js.
  const characterConfig = {
    chunkSource: procgen,
    worldSeed,
    chunkSize: CHUNK_SIZE,
    bounds: {
      minX: bounds.minCx * CHUNK_SIZE,
      minZ: bounds.minCz * CHUNK_SIZE,
      maxX: (bounds.maxCx + 1) * CHUNK_SIZE,
      maxZ: (bounds.maxCz + 1) * CHUNK_SIZE,
    },
    water: water ?? undefined,
    rules: game.rules,
    getBodyRef: () => bodyRef,
  };
  // Creatures domain (AI1, slice 6): the creatures module builds bots, crowd,
  // creatures, and needs from this config during assembly.
  // See modules/creatures/server.js.
  const botCount = Number(process.env.MMO_BOTS ?? 0);
  const botHome = process.env.MMO_BOTS_HOME?.split(",").map(Number);
  const creaturesConfig = {
    rules: game.rules,
    botCount,
    botHome: botHome && botHome.length === 2 ? { x: botHome[0], z: botHome[1] } : { x: spawn.x + 6, z: spawn.z + 10 },
    botRadius: process.env.MMO_BOTS_RADIUS ? Number(process.env.MMO_BOTS_RADIUS) : undefined,
    characterCatalog,
    groundHeightAt: (x: number, z: number) => characterOf().groundHeight(x, z),
    playerAbilities,
    // hasCrowd/crowdBackend now come from ctx.shared.navBackend (physics module)
  };
  // The biomes' wild packs follow loaded chunks (MMO_WILD_CREATURES=1).
  if (process.env.MMO_WILD_CREATURES === "1") {
    if (!biomeAt) {
      console.warn("[biomes] MMO_WILD_CREATURES=1 but this world has no biome map: no wild packs");
    } else {
      const wild = new WildCreatures({
        registry: biomes,
        // A species the overlay edits sets its pack size where the biome table doesn't.
        spawner: {
          has: (k) => creaturesOf().has(k),
          isCreature: (e) => creaturesOf().isCreature(e),
          spawnPack: (sim, k, x, z, size) => creaturesOf().spawnPack(sim, k, x, z, size ?? editedPack(speciesRoster, k)),
        },
        seed: ecologySeed32(worldSeed),
        chunkWorldSize: CHUNK_SIZE,
        biomeAt,
        // No packs in the water.
        blocked: water ? (x, z) => (water(x, z) ?? -Infinity) > characterOf().groundHeight(x, z) : undefined,
      });
      streamer.attachContents(sim, wild);
      const kinds = new Set(Object.values(biomes.biomes).flatMap((b) => b.creatures.table.map((c) => c.kind)));
      const waiting = [...kinds].filter((k) => !creaturesOf().has(k));
      console.log(
        `[biomes] wild packs on: ${wild.stats().packs} pack(s) round the spawn area` +
          (waiting.length > 0 ? `; no creature rules yet for ${waiting.join(", ")}` : ""),
      );
    }
  }
  // Stamina gating (slice 5): the combat module builds it; see combatConfig below.
  // (needs now comes from the creatures module; see creaturesConfig above)
  // (mastery now comes from the character module; see characterConfig above)
  // Economy (EC1): gold wallets (SQLite-backed). The wallet is built here
  // (before assembly) and handed to the items module via itemsConfig so
  // the module-built LootDropper can drop gold.
  const walletStore = new SqliteWalletStore(path.join(DATA_DIR, "economy.db"));
  const wallet = new WalletSystem(walletStore);
  // Items (roadmap M3a, slice 2): the items module builds the service from
  // this config during assembly. No inline construction — see
  // modules/items/server.js.
  const itemsConfig = {
    dataDir: DATA_DIR,
    rules: game.rules,
    tickHz: 30,
    groundHeightAt: (x: number, z: number) => characterOf().groundHeight(x, z),
    rankOrder: DEFAULT_LADDER.ranks.map((r) => r.id),
    ledger: itemLedger,
    kindOf: (e: number) => creaturesOf().kindOf(e),
    wallet,
  };
  // Economy (EC1): player-to-player trades, NPC vendors, auction house.
  // Items move bag-to-bag through the ItemStore; held/worn gear stays out
  // of trades in v1. Trade/vendor/auction resolve items lazily via
  // itemsOf() since the items service comes from the items module during
  // assembly; they join the tick via provided.core below (the core
  // manifest lists them), so the gateway finds them in assembled.systems.
  // The ledger startup sequence (clear strays, restore, attach) moved into
  // the items module — see modules/items/server.js.
  const trade = new TradeSystem(wallet, {
    owns: (c, item) => itemsOf().store.inBagOf(c, item),
    freeSlots: (c) => itemsOf().store.emptySlots(c),
    move: (item, from, to) => {
      if (!itemsOf().store.inBagOf(from, item)) return false;
      return itemsOf().store.putInBag(to, item) >= 0;
    },
  });
  // Vendors (EC1): NPC shops. Templates are defined here; attaching them
  // to NPC entities is content work (the `vendor` admin command attaches).
  const vendor = new VendorSystem(wallet, {
    give: (c, def) => itemsOf().give(c, def).ok,
    take: (c, item) => {
      if (!itemsOf().store.inBagOf(c, item)) return false;
      itemsOf().store.destroy(item);
      return true;
    },
    defOf: (item) => {
      const slot = itemsOf().store.slot(item);
      return slot < 0 ? -1 : itemsOf().store.defs[slot];
    },
    nameOf: (def) => itemsOf().defs.names[def] ?? `item ${def}`,
  });
  // Auction house (EC1): listings keep the item in the seller's bag (no
  // escrow limbo on restart); settlement moves it bag-to-bag.
  const auction = new AuctionSystem(wallet, {
    owns: (c, item) => itemsOf().store.inBagOf(c, item),
    freeSlots: (c) => itemsOf().store.emptySlots(c),
    defOf: (item) => {
      const slot = itemsOf().store.slot(item);
      return slot < 0 ? -1 : itemsOf().store.defs[slot];
    },
    move: (item, from, to) => {
      if (!itemsOf().store.inBagOf(from, item)) return false;
      return itemsOf().store.putInBag(to, item) >= 0;
    },
    nameOf: (def) => itemsOf().defs.names[def] ?? `item ${def}`,
  });
  // What a blow gets through: worn armour per the rules' armourHalf;
  // bots and props wear nothing. armourFactor lives in @mmo-engine/rules
  // beside the formula it feeds. Dungeon runs ask through the same
  // function, by character id.
  const wornFactor = (id: number): number => armourFactor(game.rules, itemsOf().armourTotal(id));
  // What a character swings: the item in the main hand, by the character's
  // id on its avatar. Bots and props hold nothing (fists).
  // Slice 2: items/itemDefs come from the items module during assembly.
  // Closures defined before assembly resolve them lazily via these refs.
  let itemsRef: import("./items/index.js").ItemService | null = null;
  const itemsOf = (): import("./items/index.js").ItemService => {
    if (!itemsRef) throw new Error("items not yet assembled");
    return itemsRef;
  };
  const weaponOf = (e: number): Weapon | null => {
    if (!hasComponent(sim.ecs, CharacterRef, e)) return creaturesOf().weaponOf(e);
    const def = itemsOf().mainHandDef(CharacterRef.idHi[e] * 4294967296 + CharacterRef.idLo[e]);
    if (def < 0) return null;
    const d = itemsOf().defs;
    return {
      technique: d.technique[def],
      item: { mass: d.mass[def], edge: d.edge[def], point: d.point[def], hardness: d.hardness[def] },
      reach: d.length[def],
      family: d.bases[def],
    };
  };
  // Creature drops (L2): the items module builds the dropper during assembly.
  // It receives the wallet via itemsConfig so creature kills can drop gold (EC1).
  // Rules hot reload (ED1): combat and death hold the delegate, and a
  // reload (validated off the tick, applied first thing in one) swaps the
  // hooks behind it and pushes the new tables into the systems.
  const hooks = new HooksDelegate(game.hooks);
  const reloader = new RulesReloader(game.dir, (g) => {
    game = g;
    hooks.current = g.hooks;
    creaturesOf().setRules(g.rules.creatures.creatures, g.rules.items.bases);
    dropperRef?.setCreatures(g.rules.creatures.creatures);
    dropperRef?.setTables(g.rules.loot.tables ?? {});
    itemsOf().setLoot(g.rules.loot);
    itemsOf().defs.applyRules(g.rules);
    bodyRef?.setRules(sim, g.rules.body, g.rules.appearance);
    masteryOf().setDisciplines(g.rules.disciplines.disciplines);
    magicRef?.setRules(g.rules.spells);
    console.log(`[rules] reloaded: ${g.summary}`);
  });
  // Quests and dialog (P1): the gateway's "quest" extension and a system
  // checking places and bags; kills come through the death hook below.
  const rankOrder = DEFAULT_LADDER.ranks.map((r) => r.id);
  // Quests and dialog (P1, slice 4): the quests module builds the service
  // from this config during assembly. See modules/quests/server.js.
  const questsConfig = {
    questDir: process.env.MMO_QUESTS || DEFAULT_QUEST_DIR,
    dataDir: DATA_DIR,
    getSpeciesNear: () => Object.entries(game.rules.creatures.creatures).map(([id, c]) => ({ id, name: c.name })),
    getItemBases: () => Object.keys(game.rules.items.bases).filter((b) => itemsOf().defs.ofBase(b).length > 0),
    countInBag: (character: number, base: string) => {
      let n = 0;
      for (const item of itemsOf().store.bag(character)) {
        if (item !== 0 && itemsOf().defs.bases[itemsOf().store.defs[itemsOf().store.slot(item)]] === base) n++;
      }
      return n;
    },
    grantItem: (character: number, base: string) => {
      const def = itemsOf().defs.starter(base, rankOrder);
      return def >= 0 && itemsOf().give(character, def).ok;
    },
    grantGold: (character: number, amount: number) => {
      wallet.grant(character, amount, sim.currentTick);
    },
  };
  // A scene's nodes spawn through the creature, prop, item and quest paths (EA6, data-driven entities).
  // After items and quests exist, so item and quest nodes have somewhere to go.
  if (process.env.MMO_SCENE) {
    const scene = loadSceneFile(process.env.MMO_SCENES || DEFAULT_SCENES_DIR, process.env.MMO_SCENE);
    const prefabs = loadPrefabs(process.env.MMO_PREFABS || DEFAULT_PREFABS_DIR);
    const r = spawnSceneOnBoot(
      scene,
      {
        sim,
        creatures: creaturesOf(),
        table: () => loadScatterContent().table,
        groundHeightAt: (x, z) => characterOf().groundHeight(x, z),
        prefabs,
        species: (id) => speciesRoster.roster[id],
        items: {
          place: (base, rank, x, z) => {
            const def = lineDef(itemsOf().defs, { base, rank }, rankOrder);
            return def < 0 ? null : itemsOf().placeFixture(sim, def, x, z);
          },
          discard: (ids) => ids.forEach((i) => itemsOf().discardGround(sim, i)),
        },
        quests: {
          place: (quest, x, z) => {
            const content = (questsRef as unknown as { content: { quests: Record<string, { giver?: string }>; npcs: Record<string, { x: number; z: number }> } })?.content;
            if (!content) return "quests not yet assembled";
            const giver = content.quests[quest]?.giver;
            const npc = giver === undefined ? undefined : content.npcs[giver];
            if (!npc) return `no quest "${quest}" with a giver`;
            npc.x = x;
            npc.z = z;
            return null;
          },
        },
      },
      store,
    );
    console.log(
      `[scene] ${scene.name} (${scene.kind}): ${r.spawned.length} node(s) spawned (${r.spawned.map((s) => `${s.id}=${s.what}`).join(", ")})` +
        (r.skipped.length > 0 ? `; skipped ${r.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}` : ""),
    );
  }
  // Dungeon instances (D4): the gateway's "dungeon" extension starts a
  // sandbox gateway per run from the prebaked pool and commits its result.
  // Slice 3: the dungeons module builds the pool and InstanceManager from
  // this config during assembly. See modules/dungeons/server.js.
  const instanceResults = new SqliteInstanceResultStore(path.join(DATA_DIR, "instances.db"));
  const dungeonsConfig = {
    dungeonDir: process.env.MMO_DUNGEONS || DEFAULT_DUNGEON_CONTENT,
    dataDir: DATA_DIR,
    instanceHost: process.env.MMO_INSTANCE_HOST || "localhost",
    instanceResults,
    getGame: () => game,
    credentialStore,
    characterStore,
    getGateway: () => gw,
    getWeaponOf: (character: number) => {
      const def = itemsOf().mainHandDef(character);
      if (def < 0) return null;
      const d = itemsOf().defs;
      return { technique: d.technique[def], item: { mass: d.mass[def], edge: d.edge[def], point: d.point[def], hardness: d.hardness[def] }, reach: d.length[def], family: d.bases[def] };
    },
    getArmourOf: (character: number) => wornFactor(character),
    getLootPool: () => itemsOf().defs.ofSource("mob"),
    getChestPool: () => itemsOf().defs.ofSource("chest"),
    grantItem: (character: number, def: number) => itemsOf().give(character, def).ok,
    train: (character: number, skill: string, difficulty: number, key: number) => {
      const i = masteryOf().index.of(skill);
      if (i < 0) return;
      const sheet = new SkillSheet(masteryOf().index);
      const saved = characterStore.loadSkills?.(character);
      if (saved) sheet.load(saved);
      sheet.train(i, difficulty, key, Date.now());
      characterStore.saveSkills?.(character, sheet.save());
    },
  };
  const combatSkills: CombatSkills = {
    get: (e, id) => masteryOf().sheetOf(e).get(id),
    train: (e, id, difficulty, key) => {
      const i = masteryOf().index.of(id);
      if (i >= 0) masteryOf().sheetOf(e).train(i, difficulty, key, Date.now());
    },
    techniqueSkill: (t) => game.rules.combat.techniques[t]?.skill,
    familiarity: (e, family) => masteryOf().sheetOf(e).familiarity(family),
    useFamily: (e, family) => void masteryOf().sheetOf(e).useFamily(family, Date.now()),
    knows: (e, technique) => masteryOf().knows(e, technique),
  };
  // Combat domain (M2/M5, slice 5): the combat module builds the full cluster
  // from this config during assembly. See modules/combat/server.js.
  const combatConfig = {
    rules: game.rules,
    hooks,
    combatSkills,
    getWeaponOf: weaponOf,
    getWornFactor: wornFactor,
    getCreaturesPlace: (s: unknown, e: number) => creaturesOf().place(sim, e),
    getGateway: () => gw,
    getRespawnSeconds: (e: number) => creaturesOf().respawnSeconds(e),
    getDropper: () => dropperRef,
    getQuests: () => questsRef,
    getKindOf: (e: number) => creaturesOf().kindOf(e),
  };
  // What a blow gets through: worn armour per the rules' armourHalf;
  // (armourOf and combatDamage now live in the combat module; see combatConfig above)
  // Players come back at the spawn point (placement lives in the gateway,
  // which owns the spawn grid); bots rise where they fell.
  // The dropper comes from the items module (slice 2); the death callback
  // resolves it lazily via the mutable ref assigned after assembly.
  let dropperRef: {
    onDeath(s: unknown, ev: unknown): void;
    setCreatures(c: unknown): void;
    setTables(t: unknown): void;
  } | null = null;
  // Slice 4: quests comes from the quests module; lazy ref for the death callback.
  let questsRef: { onDeath(s: unknown, ev: unknown, kindOf: (e: number) => string | undefined): void } | null = null;
  // The tick's systems (roadmap EA9): the core module's instances in the order
  // modules/core/module.json fixes, plus whatever the enabled set adds. A bad
  // set (unknown id, cycle) stops the boot with every problem listed.
  const assembled = await assembleServerSystems({
    modulesDir: path.join(REPO_ROOT, "modules"),
    setFile: process.env.MMO_MODULES || path.join(REPO_ROOT, "content", "modules.json"),
    provided: {
      core: {
        reloader,
        streamer,
        wallet,
        trade,
        vendor,
        auction,
      },
    },
    ctx: {
      sim,
      log: (m) => console.log(m),
      // Slices 2-6: modules read their bootstrap config from here.
      config: { items: itemsConfig, dungeons: dungeonsConfig, quests: questsConfig, combat: combatConfig, creatures: creaturesConfig, character: characterConfig, physics: physicsConfig },
    },
  }).catch((err: Error) => {
    console.error(`[server] ${err.message}`);
    process.exit(1);
  });
  // Slices 2-5: items, dropper, dungeons, quests, and the combat cluster
  // come from their modules.
  itemsRef = assembled.byName["items"] as import("./items/index.js").ItemService;
  dropperRef = assembled.extensions["dropper"] as unknown as {
    onDeath(s: unknown, ev: unknown): void;
    setCreatures(c: unknown): void;
    setTables(t: unknown): void;
  };
  const dungeons = assembled.extensions["dungeons"] as unknown as import("./dungeons/manager.js").InstanceManager;
  questsRef = assembled.extensions["quests"] as unknown as {
    onDeath(s: unknown, ev: unknown, kindOf: (e: number) => string | undefined): void;
  };
  const quests = questsRef as unknown as import("./net/extension.js").GatewayExtension;
  // Combat cluster (slice 5): assign bodyRef for the physics fall callback,
  // magicRef for the rules reloader.
  bodyRef = assembled.byName["body"] as unknown as import("./body.js").BodySystem;
  magicRef = assembled.byName["magic"] as unknown as import("./magic.js").MagicSystem;
  // Creatures domain (slice 6).
  creaturesRef = {
    creatures: assembled.byName["creatures"] as unknown as import("./creatures.js").CreatureSystem,
    bots: (assembled.byName["bots"] as unknown as import("./bots.js").BotSystem) ?? null,
    crowd: (assembled.byName["crowd"] as unknown as import("./navigation/crowd-system.js").CrowdSystem) ?? null,
  };
  // Physics domain (slice 8).
  physicsRef = assembled.byName["physics"] as unknown as { terrainColliders(s: number): (...a: unknown[]) => unknown };
  // Character domain (slice 7).
  characterRef = {
    character: assembled.byName["character"] as unknown as import("./index.js").CharacterSystem,
    mastery: assembled.byName["mastery"] as unknown as import("./stats/mastery-system.js").MasterySystem,
  };
  // Streamer warm/adopt (deferred from before assembly): loading pinned
  // chunks registers terrain colliders, which need physicsRef (assigned
  // above). Contents attached earlier (attachContents) still reach these
  // chunks — ChunkStreamer.load() calls contents.load per chunk.
  const adopted = streamer.adopt(sim);
  const warmed = streamer.warm(sim);
  console.log(
    `[stream] ${adopted} chunk(s) restored, ${warmed} loaded for the spawn area; ` +
      `radius ${STREAM_RADIUS} around players, world chunks ${bounds.minCx}..${bounds.maxCx} x ${bounds.minCz}..${bounds.maxCz} ` +
      `(scatter plan ${populator.planHash.slice(0, 12)}…)`,
  );
  console.log(`[modules] ${assembled.modules.join(", ")} | tick order: ${assembled.order.map((s) => s.name).join(" ")}`);
  // Session tokens survive a restart (E3): the edge's resync finds them.
  const sessionStore = new SqliteSessionStore(path.join(DATA_DIR, "world.db"));
  // Cross-region presence (S2): the gateway reports online names and asks
  // where friends play; without a world client both are inert. `worldClient`
  // is declared below and assigned when WORLD_URL is set; these closures
  // only run once players are around, long after.
  const gw: Gateway = new Gateway({
    port: PORT,
    sessionStore,
    // Chat rules from the chat module (slice 1: the gateway no longer imports
    // chat rules directly). Falls back to built-ins if the module is absent.
    chatRules: await loadChatRules(),
    // GET /health for deploy health checks (EA19); PCG's handler composes with it.
    http: healthHttpHandler,
    presence: {
      report: (names) => void worldClient?.reportPresence(names),
      query: (names) => {
        if (!worldClient) return Promise.reject(new Error("no world client"));
        return worldClient.queryPresence(names);
      },
    },
    // The same instance as in the systems list below: its sheets are what get saved.
    mastery: masteryOf(),
    body: bodyRef!,
    magic: magicRef!,
    // Per-session intent/pickup budgets and the frame cap (roadmap T1).
    ingress: game.rules.ingress,
    world: sim,
    // The streamer runs first: chunks it loads this tick are in this
    // tick's delta, and physics picks up their bodies in the same tick.
    systems: assembled.systems,
    extensions: [quests, dungeons],
    items: itemsOf(),
    // Players spawn standing on the terrain (a baked world's ground is
    // anywhere from a swamp floor below 0 to mountain tops).
    groundHeightAt: (x, z) => characterOf().groundHeight(x, z),
    creatures: {
      has: (k) => k in game.rules.creatures.creatures,
      spawnPack: (w, k, x, z) => creaturesOf().spawnPack(w, k, x, z),
      nameOf: (e) => creaturesOf().nameOf(e),
      entities: () => creaturesOf().entities(),
    },
    spawnPoint: spawn,
    // "Start from": characters enter at the chosen point, not where they were saved.
    spawnOverridden: spawnOverride !== null,
    // Baked worlds: extent + coarse map for the client's far horizon.
    worldInfo: worldInfoFor(store, tiles, CHUNK_SIZE) ?? undefined,
    credentialStore,
    characterStore,
    guildStore,
    socialStore,
    partyStore,
    characterCatalog,
    playerAbilities,
    dayClock: dayClock ?? undefined,
    startTick: freshBoot ? 1 : restoredTick! + 1,
    // Terrain-height channel (slice 4.1): the gateway attaches authoritative
    // 16x16 heights to chunk rows on network snapshots/deltas. The
    // persistence path never sees them (SnapshotStore collects separately).
    chunkSource: procgen,
    // Editor-only debug (protocol v3, 0x0a): read-only answers composed
    // from the live sim. The gateway only validates/authenticates and
    // encodes — all sim knowledge lives behind this interface.
    // The overlay draws what pathfinding can use: the tiles loaded now.
    debugSource: makeDebugSource({
      world: sim,
      navigation: assembled.byName["navigation"] as unknown as import("./navigation/system.js").NavigationSystem,
      loadedTileBounds: () => chunkNavmeshRef!.bounds(),
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
  let migrationTimer: NodeJS.Timeout | null = null;
  let presenceTimer: NodeJS.Timeout | null = null;
  if (WORLD_URL) {
    const parts = (process.env.REGION_CHUNK_RANGE ?? "0,0,4096,4096")
      .split(",")
      .map(Number);
    const chunkRange = { x0: parts[0], z0: parts[1], x1: parts[2], z1: parts[3] };
    let migration: MigrationCoordinator | null = null;
    worldClient = new WorldClient({
      transport: new WebrpcWorldTransport(WORLD_URL),
      regionId: REGION_ID,
      chunkRange,
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
      // Region migration (slice B): acks carry registry changes and
      // hand-off outcomes for the coordinator.
      onAck: (ack) => {
        void migration?.onAck(ack).catch((err: unknown) =>
          console.warn(`[server] migration ack: ${(err as Error).message}`));
      },
    });
    // Border hand-offs (WORLD-SERVER-SPEC §6): players walking into another
    // live region's chunks are handed to it; off the tick, 4 times a second.
    migration = new MigrationCoordinator({
      world: worldClient,
      host: gw.migrationHost(),
      chunkRange,
      chunkSize: CHUNK_SIZE,
      log: (line) => console.log(`[server] ${line}`),
    });
    const coordinator = migration;
    coordinator.onEvent((e) => console.log(`[server] migration ${e.kind} ${e.entityId} ${e.migrationId}`));
    gw.setMigrationAcceptor((id, verify) => coordinator.accept(id, false, verify));
    await worldClient.start();
    if (worldClient.registered) {
      console.log(`[server] registered with world at ${WORLD_URL} as ${REGION_ID}`);
      await coordinator.refreshRegistry().catch(() => {});
      migrationTimer = setInterval(() => {
        void coordinator.observe(gw.migrationPositions()).catch((err: unknown) =>
          console.warn(`[server] migration observe: ${(err as Error).message}`));
      }, 250);
      migrationTimer.unref();
      // Cross-region presence (S2): refresh friends lists from the world
      // directory on a slow timer, off the tick loop like everything here.
      presenceTimer = setInterval(() => {
        if (worldClient?.registered) {
          void gw.syncPresence().catch((err: unknown) =>
            console.warn(`[server] presence sync: ${(err as Error).message}`));
        }
      }, 30_000);
      presenceTimer.unref();
    } else {
      console.warn(`[server] world registration failed; running standalone`);
    }
  }

  // A slow or dead world server must never stall the region: dungeon
  // reports never overlap (no pile-up of in-flight POSTs) and never
  // touch the tick loop (this timer only).
  let dungeonFlushInFlight = false;
  const saveTimer = setInterval(() => {
    itemLedger.flush();
    gw.saveCharacters();
    if (gw.serverTick >= nextSaveTick) {
      const result = store.saveWorld(gw.serverTick, sim);
      const st = streamer.stats;
      console.log(
        `[server] saved tick ${result.tick} (${result.entityCount} entities, ${result.bytes} B, ${result.ms.toFixed(1)} ms) | ` +
          `chunks ${st.loaded} loaded, ${st.queued} queued, ${st.loads} loads / ${st.unloads} unloads, navmesh ${chunkNavmeshRef!.size} tile(s)`,
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
        // Dungeon runs (D4): fold the committed batch into the next world
        // report. Rows stay unreported until the world confirms them
        // ingested, so a failed flush retries on the next save. Skipped
        // while one is in flight: a hung world must not stack up POSTs.
        if (!dungeonFlushInFlight) {
          dungeonFlushInFlight = true;
          void flushInstanceResults(instanceResults, (results) => worldClient.reportDungeonResults(results)).then(
            ({ reported }) => {
              dungeonFlushInFlight = false;
              if (reported > 0) console.log(`[server] reported ${reported} dungeon run(s) to the world`);
            },
            (err: unknown) => {
              dungeonFlushInFlight = false;
              console.warn(`[server] dungeon report: ${(err as Error).message}`);
            },
          );
        }
      }
      nextSaveTick += SAVE_EVERY_TICKS;
    }
  }, 1000);
  saveTimer.unref();

  installShutdownHook(store, () => ({ tick: gw.serverTick, sim }), {
    onSaved: (result, signal) => {
      console.log(`[server] shutdown save on ${signal}: tick ${result.tick}`);
      // Runs still going report now, so their loot is in the ledger flush below.
      dungeons.endAll();
      gw.saveCharacters();
      itemLedger.flush();
      itemLedger.close();
      sessionStore.close();
      void coreChannel?.close();
      // Best-effort deregister; the world's stale-region reaper is the
      // backstop if this doesn't land before exit.
      if (migrationTimer) clearInterval(migrationTimer);
      if (presenceTimer) clearInterval(presenceTimer);
      void worldClient?.stop();
      reloader.close();
    },
  });

  // PCG assets: the Pcg webrpc service on the game port (pcg.ridl).
  const pcg = startPcgService(gw, process.env.MMO_PCG_ASSETS || undefined);
  const port = await gw.listen();
  // The edge's channel (E3), beside the player port. A core that cannot
  // bind it still serves players directly.
  const channelPort = coreChannelPort();
  const coreChannel = await startCoreChannel(gw, channelPort).catch((err: Error) => {
    console.warn(`[server] core channel not serving on 127.0.0.1:${channelPort}: ${err.message}`);
    return null;
  });
  if (coreChannel) console.log(`[server] core channel on 127.0.0.1:${channelPort} (edge/core split)`);
  gw.startTicking();
  reloader.watch();
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
  console.log(`[server] listening on ws://0.0.0.0:${port} via ${gw.transportName === "uws" ? "uWebSockets.js" : "ws"}${pcg ? ` (+ webrpc http://0.0.0.0:${port}/rpc/Pcg)` : ""}`);
  console.log(`[server] ${pcg ? pcg.summary : "no PCG asset library (MMO_PCG_ASSETS)"}`);
  console.log(
    `[server] ${freshBoot ? "fresh boot" : `restored at tick ${restoredTick}`} | ` +
      `seed ${worldSeed} | chunk ${CHUNK_SIZE}u | ` +
      `terrain ${storedTiles > 0 ? `${storedTiles} stored tile(s)` : `amp ${terrain.amplitude} freq ${terrain.frequency} (v${terrainVersion})`} | ` +
      `spawn (${spawn.x}, ${spawn.z}) | navmesh ${chunkNavmeshRef!.size} tile(s) | ` +
      `water ${water ? "from the bake" : "none"} | players can ${abilityNames(playerAbilities)} | ${dayClock ? `a day lasts ${dayClock.seconds} s` : "no day cycle"} | data ${DATA_DIR}`,
  );
  console.log(
    `[server] no users yet? create one in the client ("Create account" tab), or: MMO_DEV_PASSWORD=<8-128 chars> npm run seed:user --workspace=@mmo-engine/engine-core -- <name>`,
  );
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
