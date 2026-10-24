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
 *   MMO_EDGE       "1": players connect to the edge (EDGE_GAME_PORT), which
 *                  relays them over the core channel; the core binds no
 *                  player port (E3b). Unset: players connect here directly.
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
 *                  content/quests); a missing dir means no quests, not a boot
 *                  failure. Quest logs live in <data>/quests.db
 *   MMO_DUNGEONS   dungeon instance rules and entrances dir (default: the
 *                  repo's content/dungeons); a missing dir means no dungeons,
 *                  not a boot failure. Layouts come from the pool at
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
 *   MMO_WILDLIFE   with MMO_WILD_CREATURES=1: also plan the wildlife table
 *                  (1 = content/wildlife/wildlife.json, or a file): trophic
 *                  ratios, danger ramping with distance from the spawn,
 *                  safe radius (docs/WILDLIFE.md), and turn the table's
 *                  species into creature kinds with a brain (flee, defend,
 *                  territorial, hunt, raid). The boot scene's structures are
 *                  the settlements (livestock ring, safe radius, raids).
 *                  MMO_WILDLIFE_LOG=1 logs each pack spawned.
 *   MMO_SCENE      a scene (content/scenes/<name>.scene.json) whose nodes spawn at boot as
 *                  creatures, props, items and quest posts (roadmap EA6); MMO_SCENES
 *                  overrides the scenes dir (alias MMO_SCENES_DIR, as bake:all names it),
 *                  MMO_PREFABS the prefab files (content/prefabs)
 *   MMO_SPECIES    the species overlay file (default content/species/species.json),
 *                  merged over the built-in roster; a bad file stops the boot
 *   MMO_CRAFTING   the crafting rules (default content/crafting/recipes.json);
 *                  a missing file means no crafting, not a boot failure; a bad
 *                  file stops the boot
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
 *   REGION_CHUNK_RANGE "x0,z0,x1,z1" owned chunk bounds; when set, the
 *                      streamer loads only inside it. When WORLD_URL is
 *                      set and this is NOT set, the shard boots
 *                      unassigned (persistence P5): the world assigns a
 *                      range sized by the host's reported resources.
 *   MMO_HOST_ID        host id for assignment mode (default: hostname)
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
import { loadPersistenceSettings, loadWorldSettings } from "./server-settings.js";
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
  planFleetBoot,
  MigrationCoordinator,
  waterSurfaceFromMaps,
  type ChunkBounds,
} from "./index.js";
import { Ability, timeOfDayAt, type DayClock } from "@mmo-engine/protocol";
import { worldInfoFor } from "./terrain/world-info.js";
import { startPcgService } from "./pcg/boot.js";
import { ShardStateShipper, SNAPSHOT_UPLOAD_EVERY_TICKS } from "./world/state-shipper.js";
import { WorldCharacterSync } from "./world/character-sync.js";
import { SocialWorldSync } from "./world/social-sync.js";
import { LocalEconomyView, WorldAtomicOps } from "./world/atomic-ops.js";
import { recallShardState } from "./world/state-recall.js";
import { healthHttpHandler } from "./net/health.js";
import { clampSpawn, parseSpawnOverride } from "./spawn-override.js";
import { armourFactor, RulesError } from "@mmo-engine/rules";
import { DEFAULT_LADDER } from "@mmo-engine/compose";
import { loadGameRules, type GameRules } from "./rules/boot.js";
import { assembleServerSystems, type ServerModuleContext } from "./modules.js";
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
import { GatheringSystem, materialCountsOf, nodeStocksOf, SqliteGatheringStore } from "./gathering/index.js";
import { questRecordsOf } from "./quests/quest-store.js";
import { hasComponent } from "bitecs";
import { CharacterRef, God, Health } from "./components.js";
import { SkillSheet } from "./stats/mastery.js";
import { DEFAULT_QUEST_DIR } from "./quests/content.js";
import { DEFAULT_DUNGEON_CONTENT } from "./dungeons/content.js";
import { flushInstanceResults } from "./dungeons/results.js";
import { expandPrefabs, worldNodes } from "@mmo-engine/scene";
import { DEFAULT_PREFABS_DIR, DEFAULT_SCENES_DIR, loadPrefabs, loadSceneFile, spawnSceneOnBoot } from "./scene-spawn.js";
import { editedPack, loadServerRoster, type ServerRoster } from "./species-roster.js";
import { EMPTY_CRAFTING_RULES, loadCraftingRules, type CraftingRules } from "@mmo-engine/crafting";
import { CraftingService } from "./crafting/crafting-service.js";
import { assertEngineSkillContract } from "./rules/skill-contract.js";
import { loadScatterContent } from "./procgen/scatter-spawn.js";
import { landDry, riverAtFromMap, surfaceAt } from "./procgen/habitat.js";
import { NavObstacleSystem } from "./navigation/obstacle-system.js";
import { TILE_CACHE_SETTINGS } from "./navigation/chunk-baker.js";
import { loadCharacterCatalog, MemoryCharacterStore } from "./characters/index.js";
import { ART_CATALOG, makeWorldPopulator } from "./procgen/world-populator.js";
import { catalogBounds } from "./procgen/prop-shape.js";
import { loadScale } from "./scale.js";
import { FormationTileStore } from "./persist/formation-tiles.js";
import { ItemLedger } from "./persist/item-ledger.js";
import { biomeLookup } from "./terrain/biome-lookup.js";
import { checkBiomeRegistry, DEFAULT_BIOME_REGISTRY, loadBiomeRegistry } from "./procgen/biome-registry.js";
import { WildCreatures } from "./procgen/wild-creatures.js";
import { DEFAULT_WILDLIFE_TABLE, loadWildlifeTable, planWildlifeChunk } from "./procgen/wildlife-table.js";
import { loadNaturalWeapons, wildlifeCreatures, withWildlife } from "./procgen/wildlife-creatures.js";
import { sceneSettlements } from "./procgen/wildlife-settlements.js";
import type { RaidSettlement } from "./creatures.js";
import type { TelegraphSystem } from "./telegraph.js";
import type { CombatSystem } from "./combat.js";
import { ecologySeed32 } from "./procgen/ecology.js";
import { lineDef, rollTable } from "./items/index.js";
import { BreakSystem, breakDefsOf, ChestSystem, loadStructureBreakables, loadVendorTemplates, placeRecordsOf, SqlitePlacesStore } from "./interact/index.js";
import { SqliteSessionStore } from "./auth/index.js";
import { coreChannelPort, startCoreChannel } from "./channel-server.js";
import { ChannelTransport, type EdgePush } from "./net/channel-transport.js";
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
const EDGE_MODE = process.env.MMO_EDGE === "1";
const DATA_DIR = path.resolve(process.env.MMO_DATA_DIR ?? "./data");
const WORLD_SEED = BigInt(process.env.MMO_WORLD_SEED ?? 1234);
const CHUNK_SIZE = Number(process.env.MMO_CHUNK_SIZE ?? 16);
// Save cadence and history (content/server/persistence.json, EG13; MMO_SERVER_SETTINGS overrides the folder).
const persistenceSettings = loadPersistenceSettings(process.env.MMO_SERVER_SETTINGS || undefined);
if (persistenceSettings.problem) console.warn(`[server] persistence settings ignored: ${persistenceSettings.problem}`);
// The day cycle and bots (content/server/world.json, EG14); the MMO_DAY_* and MMO_BOTS* variables still win.
const worldSettings = loadWorldSettings(process.env.MMO_SERVER_SETTINGS || undefined);
if (worldSettings.problem) console.warn(`[server] world settings ignored: ${worldSettings.problem}`);
/** The tick runs at 30 Hz (tick-loop.ts). */
const SAVE_EVERY_TICKS = Math.max(1, Math.round(persistenceSettings.settings.saveEverySeconds * 30));
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
  // The engine's skill contract: systems name content-defined skill and
  // technique ids. A pack that declares skills must declare every one the
  // engine needs — fail loud here, never silent 0s mid-game.
  try {
    assertEngineSkillContract(game.rules, game.dir);
  } catch (err) {
    console.error(`[server] ${(err as Error).message}`);
    process.exit(1);
  }
  // The wildlife table's species become creature kinds (docs/WILDLIFE.md), under any the rules define.
  const wildlifeTable = process.env.MMO_WILDLIFE ? loadWildlifeTable(process.env.MMO_WILDLIFE === "1" ? DEFAULT_WILDLIFE_TABLE : process.env.MMO_WILDLIFE) : null;
  const wildlifeKinds = wildlifeTable ? wildlifeCreatures(wildlifeTable, loadNaturalWeapons()) : null;
  if (wildlifeKinds) game.rules.creatures.creatures = withWildlife(game.rules.creatures.creatures, wildlifeKinds);
  // Authored data beyond the rules: the species roster and the crafting rules.
  let speciesRoster: ServerRoster;
  let crafting: CraftingRules | null;
  try {
    speciesRoster = loadServerRoster();
    crafting = loadCraftingRules(process.env.MMO_CRAFTING || undefined);
  } catch (err) {
    console.error(`[server] ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`[${speciesRoster.summary}]`);
  console.log(
    crafting
      ? `[crafting: ${Object.keys(crafting.refining).length} refining recipe(s), ${Object.keys(crafting.reagents).length} element reagent(s)]`
      : `[crafting: no crafting content]`,
  );
  // The combat moves (content/combat/moves.json, MMO_COMBAT): timing, chaining and travel the fight runs on.
  const combatLine = loadCombatContent(process.env.MMO_COMBAT || undefined);
  if (combatLine) console.log(`[server] ${combatLine}`);

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // ---- persistence: restore the world if a snapshot exists --------------
  const store = new SnapshotStore({
    dbPath: path.join(DATA_DIR, "world.db"),
    saveEveryTicks: SAVE_EVERY_TICKS,
    keepSnapshots: persistenceSettings.settings.keepSnapshots,
    walSizeLimitBytes: persistenceSettings.settings.walLimitMb * 1024 * 1024,
  });
  // A world baked from a spec carries its own seed: scatter, navmesh keys,
  // and anything generated later must agree with its baked terrain.
  const bakedSeed = store.getMeta("world_seed");
  const worldSeed = bakedSeed !== null ? BigInt(bakedSeed) : WORLD_SEED;
  if (bakedSeed !== null && process.env.MMO_WORLD_SEED !== undefined && worldSeed !== WORLD_SEED) {
    console.warn(`[server] MMO_WORLD_SEED=${WORLD_SEED} ignored: this world was baked with seed ${worldSeed}`);
  }
  const sim = new SimWorld({ stats: game.rules.stats, movement: game.rules.movement });

  // ---- persistence P3: fleet boot recall --------------------------------
  // With WORLD_URL set, the world store is the single source of truth
  // and hot-loading from it is the normal boot path: register first
  // (P1 recall reads require an authenticated known region, and
  // registration issues this boot's fresh fencing epoch), recall into
  // the local stores, and only then restore + simulate below. The
  // WorldClient created here is the one the migration coordinator and
  // the P2 shipper use for the rest of the boot, so every post-boot
  // state-plane write carries the post-boot epoch. Standalone mode
  // (no WORLD_URL) engages none of this: local restore, unchanged.
  // Every item change, appended to world.db and written each second
  // (roadmap P2a); created here so recall can import into it.
  const itemLedger = new ItemLedger(path.join(DATA_DIR, "world.db"), { autoCheckpoint: false });
  const WORLD_URL = process.env.WORLD_URL;
  const REGION_ID = process.env.REGION_ID ?? "region-1";
  const REGION_CAPACITY = Number(process.env.REGION_CAPACITY ?? 1000);
  let worldClient: WorldClient | null = null;
  let migrationCoordinator: MigrationCoordinator | null = null;
  // Persistence P5: the boot mode is planned from the env alone.
  // Standalone (no WORLD_URL) constructs no client and makes no world
  // calls. Explicit (REGION_CHUNK_RANGE set) is the P3 path verbatim.
  // Assigned (WORLD_URL set, no explicit range): the shard boots
  // unassigned, registers with its hostId, and the lease grants its
  // range + epoch — recall below then runs for the assigned range.
  const bootPlan = planFleetBoot(process.env);
  // The range this shard effectively owns, once known: the explicit
  // range, or the assigned range after registration. The streamer
  // bounds below clamp to it exactly as they clamped to the env range.
  let fleetChunkRange: { x0: number; x1: number; z0: number; z1: number } | null =
    bootPlan.mode === "explicit" ? bootPlan.chunkRange : null;
  if (bootPlan.mode !== "standalone") {
    worldClient = new WorldClient({
      transport: new WebrpcWorldTransport(WORLD_URL!),
      regionId: REGION_ID,
      chunkRange: bootPlan.mode === "explicit" ? bootPlan.chunkRange : undefined,
      hostId: bootPlan.mode === "assigned" ? bootPlan.hostId : undefined,
      endpoint: process.env.REGION_ENDPOINT ?? `ws://localhost:${PORT}`,
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
      // hand-off outcomes for the coordinator (built after the gateway
      // exists, below; it reads this ref once assigned).
      onAck: (ack) => {
        void migrationCoordinator?.onAck(ack).catch((err: unknown) =>
          console.warn(`[server] migration ack: ${(err as Error).message}`));
      },
    });
    await worldClient.start();
    if (worldClient.registered) {
      // In assignment mode the granted range arrives with the lease;
      // the P2 shipper and P4 character sync read it from this same
      // client, so they pick it up unchanged.
      fleetChunkRange = worldClient.chunkRange ?? fleetChunkRange;
      console.log(
        `[server] registered with world at ${WORLD_URL} as ${REGION_ID} (epoch ${worldClient.epoch})` +
          (bootPlan.mode === "assigned" && fleetChunkRange
            ? ` — assigned range ${fleetChunkRange.x0},${fleetChunkRange.z0}..${fleetChunkRange.x1},${fleetChunkRange.z1} via host ${bootPlan.hostId}`
            : ""),
      );
      // Recall completes here, before the restore below and long
      // before the gateway starts ticking: the ordering invariant.
      await recallShardState({
        client: worldClient,
        store,
        ledger: itemLedger,
        log: (line) => console.log(`[server] ${line}`),
        // Node stocks (PL3a) go into gathering.db before the gathering system opens it, below.
        seedPlaces: (places) => {
          const nodes = new SqliteGatheringStore(path.join(DATA_DIR, "gathering.db"));
          try {
            nodes.replaceNodes(nodeStocksOf(places["resource_nodes"]));
          } finally {
            nodes.close();
          }
          // Broken props, opened chests and doors (IX5) go into places.db the same way.
          const records = new SqlitePlacesStore(path.join(DATA_DIR, "places.db"));
          try {
            records.replaceAll(placeRecordsOf(places["place_records"]));
          } finally {
            records.close();
          }
        },
      });
    } else {
      console.warn(`[server] world registration failed; running with local state only`);
    }
  }

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
  if (fleetChunkRange) {
    // A region streams only the chunks it owns: the explicit
    // REGION_CHUNK_RANGE, or (P5) the range the world assigned.
    const { x0, z0, x1, z1 } = fleetChunkRange;
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
  // The item ledger (roadmap P2a) is created with the snapshot store
  // above, so the P3 recall could import world events into it.
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
  // The global scale (content/scale.json, MMO_SCALE): a bad file refuses to boot.
  const scale = loadScale();
  // What grows on new chunks (see world-populator: ecology or PCG).
  const populator = await makeWorldPopulator({
    scale,
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
  // Domain stores (characters, guilds, social, parties, instance results)
  // are built by their modules during assembly and published on
  // moduleCtx.stores; server.ts reads them back post-assembly below.
  // credentialStore stays here: auth is irreducible core.
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
  const dayClock = dayClockFromEnv(
    process.env.MMO_DAY_SECONDS ?? String(worldSettings.settings.daySeconds),
    process.env.MMO_DAY_OFFSET ?? String(worldSettings.settings.dayOffset),
  );
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
    dataDir: DATA_DIR,
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
  // Wildlife: the animal models (gitignored local species -> catalog ids, `npm run wildlife:models`) and the towns of the boot scene.
  const wildlifeModels: Record<string, string[]> = (() => {
    const f = new URL("../../content/wildlife/models.local.json", import.meta.url);
    try { return wildlifeTable && fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, string[]>) : {}; } catch { return {}; }
  })();
  const modelPick = new Map<string, number>();
  const wildlifeModelOf = (kind: string): string | undefined => {
    const ids = wildlifeModels[kind];
    if (!ids?.length) return undefined;
    const n = modelPick.get(kind) ?? 0;
    modelPick.set(kind, n + 1);
    return ids[n % ids.length];
  };
  const wildlifeSettlements: RaidSettlement[] =
    wildlifeTable && process.env.MMO_SCENE
      ? sceneSettlements(loadSceneFile(process.env.MMO_SCENES || DEFAULT_SCENES_DIR, process.env.MMO_SCENE), loadPrefabs(process.env.MMO_PREFABS || DEFAULT_PREFABS_DIR))
      : [];
  const botCount = Number(process.env.MMO_BOTS ?? worldSettings.settings.bots.count);
  const botHome = process.env.MMO_BOTS_HOME?.split(",").map(Number) ?? worldSettings.settings.bots.home ?? undefined;
  const creaturesConfig = {
    rules: game.rules,
    botCount,
    botHome: botHome && botHome.length === 2 ? { x: botHome[0], z: botHome[1] } : { x: spawn.x + 6, z: spawn.z + 10 },
    botRadius: process.env.MMO_BOTS_RADIUS ? Number(process.env.MMO_BOTS_RADIUS) : worldSettings.settings.bots.radiusM,
    characterCatalog,
    groundHeightAt: (x: number, z: number) => characterOf().groundHeight(x, z),
    playerAbilities,
    // hasCrowd/crowdBackend now come from ctx.shared.navBackend (physics module)
    // Wildlife (docs/WILDLIFE.md): the day clock, the warning cones, who hurt a creature, the water, the animal models, the towns raiders go for.
    timeOfDay: dayClock ? (tick: number) => timeOfDayAt(dayClock, tick, 30) : undefined,
    warn: (e: number, x: number, z: number, yaw: number, range: number, ms: number, tick: number) => {
      const tg = (assembled.byName["telegraphs"] as unknown as TelegraphSystem | undefined);
      tg?.cast(sim, { source: e, shape: { kind: "cone", x, z, yaw, range, halfAngle: 0.7 }, warnMs: ms, amount: 0 }, tick);
    },
    cancelWarn: (e: number, tick: number) => { (assembled.byName["telegraphs"] as unknown as TelegraphSystem | undefined)?.cancelFrom(e, tick); },
    attackerOf: (e: number) => (assembled.byName["combat"] as unknown as CombatSystem | undefined)?.lastAttacker(e),
    waterSurfaceAt: water ? (x: number, z: number) => surfaceAt(water, seaLevelMeta === null ? undefined : Number(seaLevelMeta), x, z) : undefined,
    waterDepthAt: water ? (x: number, z: number) => { const s = surfaceAt(water, seaLevelMeta === null ? undefined : Number(seaLevelMeta), x, z); return s === null ? 0 : Math.max(0, s - characterOf().groundHeight(x, z)); } : undefined,
    modelOf: wildlifeModelOf,
    settlements: () => wildlifeSettlements,
  };
  // The biomes' wild packs follow loaded chunks (MMO_WILD_CREATURES=1).
  let startWild: (() => void) | null = null;
  if (process.env.MMO_WILD_CREATURES === "1") {
    if (!biomeAt) {
      console.warn("[biomes] MMO_WILD_CREATURES=1 but this world has no biome map: no wild packs");
    } else {
      const wild = new WildCreatures({
        registry: biomes,
        log: process.env.MMO_WILDLIFE_LOG === "1" ? (l) => console.log(l) : undefined,
        extraPlan: wildlifeTable
          ? (cx, cz) => planWildlifeChunk(wildlifeTable, {
              seed: ecologySeed32(worldSeed), cx, cz, chunkWorldSize: CHUNK_SIZE, biomeAt,
              centres: [{ x: spawn.x, z: spawn.z, kind: "spawn" }, ...wildlifeSettlements.map((s) => ({ x: s.x, z: s.z, kind: "settlement" as const }))],
              depthAt: water ? (x, z) => { const w = surfaceAt(water, seaLevelMeta === null ? undefined : Number(seaLevelMeta), x, z); return w === null ? null : w - characterOf().groundHeight(x, z); } : undefined,
              spawnable: (k) => creaturesOf().has(k),
            })
          : undefined,
        // A species the overlay edits sets its pack size where the biome table doesn't.
        spawner: {
          has: (k) => creaturesOf().has(k),
          isCreature: (e) => creaturesOf().isCreature(e),
          spawnPack: (sim, k, x, z, size) => creaturesOf().spawnPack(sim, k, x, z, size ?? editedPack(speciesRoster, k)),
        },
        seed: ecologySeed32(worldSeed),
        chunkWorldSize: CHUNK_SIZE,
        biomeAt,
        // No packs in the water, nor on ground at or below the sea (the lake lookup finds no water near a low dry basin).
        blocked: water
          ? (x, z, aquatic) => {
              const ground = characterOf().groundHeight(x, z);
              const surface = surfaceAt(water, seaLevelMeta === null ? undefined : Number(seaLevelMeta), x, z);
              // Aquatic packs need deep enough water to swim in; land packs need dry ground.
              return aquatic ? surface === null || surface - ground < 1 : !landDry(ground, surface, 0);
            }
          : (_x, _z, aquatic) => aquatic,
      });
      // The chunks already loaded spawn their packs on attach, which needs the creature system: that is
      // assembled below, so the hook goes on once it is (startWild).
      startWild = () => {
        streamer.attachContents(sim, wild);
        const kinds = new Set(Object.values(biomes.biomes).flatMap((b) => b.creatures.table.map((c) => c.kind)));
        const waiting = [...kinds].filter((k) => !(k in game.rules.creatures.creatures));
        const st = wild.stats();
        console.log(
          `[biomes] wild packs on: ${st.packs} pack(s), ${st.creatures} creature(s) round the spawn area` +
            (waiting.length > 0 ? `; no creature rules yet for ${waiting.join(", ")}` : ""),
        );
      };
    }
  }
  // Stamina gating (slice 5): the combat module builds it; see combatConfig below.
  // (needs now comes from the creatures module; see creaturesConfig above)
  // (mastery now comes from the character module; see characterConfig above)
  // Economy (EC1): the economy module builds the wallet, trade, vendor and
  // auction systems during assembly (see modules/economy/server.js). The
  // wallet holder is filled post-assembly for pre-assembly configs that
  // need it (quests grantGold); the items module reads ctx.stores.wallet
  // directly since economy is its dependency.
  const walletHolder: { current: import("./economy/wallet.js").WalletSystem | null } = { current: null };
  // Gathering: resource nodes from the boot scene (tree stands, ore veins, fishing spots) and the materials pouch.
  // A gather trains the node's skill (woodcutting, mining, fishing) on the gatherer's sheet.
  // Reach, pace, pouch size, training and regrow pace come from content/rules/gathering.json (hot-reloaded, EG11).
  const gatheringStore = new SqliteGatheringStore(path.join(DATA_DIR, "gathering.db"));
  const gathering = new GatheringSystem({
    reachM: game.rules.gathering.reachM,
    cooldownMs: game.rules.gathering.cooldownSeconds * 1000,
    pouchMax: game.rules.gathering.pouchMax,
    trainPerTier: game.rules.gathering.trainDifficultyPerTier,
    regrowCheckSeconds: game.rules.gathering.regrowCheckSeconds,
    regrowHourMs: game.rules.gathering.regrowHourSeconds * 1000,
    store: gatheringStore,
    train: (avatar, skill, difficulty, key) => {
      const i = masteryOf().index.of(skill);
      if (i >= 0) masteryOf().sheetOf(avatar).train(i, difficulty, key, Date.now());
    },
  });
  // Items (roadmap M3a, slice 2): the items module builds the service from
  // this config during assembly. No inline construction — see
  // modules/items/server.js.
  // Atomic operations A2: with a world client, the grant path's commit
  // executor delegates to the atomic-ops coordinator; the coordinator
  // itself is built after assembly (it fences through the character
  // sync), so the executor resolves it lazily through this ref. In
  // standalone mode the executor is absent and grants stay local.
  const atomicOpsRef: { ops: WorldAtomicOps | null } = { ops: null };
  const itemsConfig = {
    dataDir: DATA_DIR,
    rules: game.rules,
    tickHz: 30,
    groundHeightAt: (x: number, z: number) => characterOf().groundHeight(x, z),
    rankOrder: DEFAULT_LADDER.ranks.map((r) => r.id),
    ledger: itemLedger,
    kindOf: (e: number) => creaturesOf().kindOf(e),
    ...(worldClient
      ? {
          atomicGrant: {
            loot: async (character: number, sourceId: string, instanceId: string, def: number) => {
              const ops = atomicOpsRef.ops;
              if (!ops) throw new Error("atomic ops not wired");
              const r = await ops.loot({ character, sourceId, instanceId, def });
              return r.ok
                ? { ok: true as const }
                : { ok: false as const, message: `grant refused by the world (${r.rejection}: ${r.message})` };
            },
          },
        }
      : {}),
  };
  // Crafting (gateway execution): the "craft" GatewayExtension validates
  // incoming craft/recipe messages with Zod at the boundary and executes
  // through the @mmo-engine/crafting rules — recipe derivation, mastery
  // check, material consumption, item grant. The service owns no storage:
  // mastery reads the MasterySystem's sheets, the crafted item resolves to
  // a loot-pool def by (base, rank), and raw materials live in a
  // per-character pouch. The pouch is in-memory for this slice; persisting
  // it (a SqliteMaterialStore beside SqliteQuestStore) is the follow-up —
  // the countMaterial/takeMaterial seam makes that swap mechanical.
  // Gathering (which fills the pouch) is a later slice.
  const materialPouch = new Map<number, Map<string, number>>();
  const pouchOf = (character: number): Map<string, number> => {
    let p = materialPouch.get(character);
    if (!p) materialPouch.set(character, (p = new Map()));
    return p;
  };
  const craftingService = new CraftingService({
    rules: crafting ?? EMPTY_CRAFTING_RULES,
    masteryOf: (entity, skill) => masteryOf().sheetOf(entity).get(skill),
    countMaterial: (character, material) => pouchOf(character).get(material) ?? 0,
    takeMaterial: (character, material, qty) => {
      const p = pouchOf(character);
      const have = p.get(material) ?? 0;
      if (have < qty) return false;
      if (have === qty) p.delete(material);
      else p.set(material, have - qty);
      return true;
    },
    hasBagRoom: (character) => itemsOf().store.hasRoom(character),
    grantItem: (character, item, rank) => {
      const d = itemsOf().defs;
      const def = d.ofBase(item).find((i) => d.ranks[i] === rank) ?? -1;
      return def >= 0 && itemsOf().give(character, def).ok;
    },
    // Fleet mode (atomic ops A2): with a world client, the craft's
    // commit routes through the coordinator's craftExecute and the
    // produced item is materialised by the settled outcome instead of
    // a local grant — same lazy-ref pattern as the grant path above.
    // Standalone: no executor, crafts stay local.
    ...(worldClient
      ? {
          atomicCraft: {
            craft: async (
              character: number,
              consumes: Array<{ instanceId: string; count: number }>,
              goldFee: number,
              outputs: Array<{ instanceId: string; def: number }>,
            ) => {
              const ops = atomicOpsRef.ops;
              if (!ops) throw new Error("atomic ops not wired");
              const r = await ops.craft({ character, consumes, goldFee, outputs });
              return r.ok
                ? { ok: true as const }
                : { ok: false as const, message: `craft refused by the world (${r.rejection}: ${r.message})` };
            },
          },
          defOfItem: (item: string, rank: string) => {
            const d = itemsOf().defs;
            return d.ofBase(item).find((i) => d.ranks[i] === rank) ?? -1;
          },
          allocateItem: (def: number) => itemsOf().store.create(def, itemsOf().defs.durability[def]),
          discardItem: (item: number) => itemsOf().store.destroy(item),
          itemInBag: (character: number, item: number) => itemsOf().store.inBagOf(character, item),
        }
      : {}),
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
  // It receives the wallet via ctx.stores (published by the economy module) so creature kills can drop gold (EC1).
  // Rules hot reload (ED1): combat and death hold the delegate, and a
  // reload (validated off the tick, applied first thing in one) swaps the
  // hooks behind it and pushes the new tables into the systems.
  const hooks = new HooksDelegate(game.hooks);
  const reloader = new RulesReloader(game.dir, (g) => {
    game = g;
    hooks.current = g.hooks;
    if (wildlifeKinds) g.rules.creatures.creatures = withWildlife(g.rules.creatures.creatures, wildlifeKinds);
    creaturesOf().setRules(g.rules.creatures.creatures, g.rules.items.bases);
    creaturesOf().setAi(g.rules.creatures.ai);
    dropperRef?.setCreatures(g.rules.creatures.creatures);
    dropperRef?.setTables(g.rules.loot.tables ?? {});
    itemsOf().setLoot(g.rules.loot);
    itemsOf().defs.applyRules(g.rules);
    bodyRef?.setRules(sim, g.rules.body, g.rules.appearance);
    // Movement (EG5): systems read sim.movement each step; creatures follow a changed walk.
    sim.movement = g.rules.movement;
    masteryOf().setDisciplines(g.rules.disciplines.disciplines);
    masteryOf().setPacing(g.rules.skills.pacing);
    gathering.setRules(g.rules.gathering);
    // Social limits (EG9): the reloader only watches after the gateway exists.
    gw.setSocial(g.rules.social);
    magicRef?.setRules(g.rules.spells);
    console.log(`[rules] reloaded: ${g.summary}`);
  });
  // Quests and dialog (P1): the gateway's "quest" extension and a system
  // checking places and bags; kills come through the death hook below.
  const rankOrder = DEFAULT_LADDER.ranks.map((r) => r.id);
  // World chests (IX1): scene Structures with a Chest component; opened chests drop their loot table at the chest.
  let chestSeed = 20261024;
  const dropTable = (s: SimWorld, table: string, x: number, z: number, owner: number): number => {
    const items = itemsOf();
    const defs = rollTable(game.rules.loot.tables ?? {}, table, items.defs, rankOrder, () => (chestSeed = (Math.imul(chestSeed, 1664525) + 1013904223) >>> 0) / 4294967296);
    defs.forEach((def, i) => items.spawnDrop(s, def, x + Math.cos(i * 2.4) * 0.8, z + Math.sin(i * 2.4) * 0.8, owner));
    return defs.length;
  };
  // What players changed in the world that the snapshot does not keep: broken props, opened chests and doors (IX5).
  const placesStore = new SqlitePlacesStore(path.join(DATA_DIR, "places.db"));
  const chests = new ChestSystem({
    has: (holder, base) => itemsOf().countBase(holder, base) > 0,
    take: (holder, base) => itemsOf().takeBase(holder, base),
    drop: dropTable,
    store: placesStore,
  });
  // Props that break (IX4, IX5): a scene node with a Breakable component. The last attacker owns the loot.
  // Shops placed in scenes (IX8): content/vendors.json templates, defined on the economy's vendor system the first time a node names one.
  const vendorTemplates = loadVendorTemplates(process.env.MMO_VENDORS || path.join(REPO_ROOT, "content", "vendors.json"));
  const structureKinds = loadStructureBreakables(process.env.MMO_STRUCTURES || path.join(REPO_ROOT, "content", "structures.json"));
  const breaks: BreakSystem = new BreakSystem(breakDefsOf(), {
    store: placesStore,
    // Mending a building spends the pouch (gathered materials).
    materials: { count: (holder, material) => gathering.countOf(holder, material), spend: (holder, material, n) => gathering.spend(holder, material, n) },
    killerOf: (e: number): number | undefined => (assembled.byName["combat"] as unknown as CombatSystem | undefined)?.lastAttacker(e),
    onBreak: (s, ev) => {
      if (ev.loot === undefined) return;
      const killer = ev.killer;
      const owner = killer !== undefined && hasComponent(s.ecs, CharacterRef, killer) ? CharacterRef.idHi[killer] * 4294967296 + CharacterRef.idLo[killer] : 0;
      dropTable(s, ev.loot, ev.x, ev.z, owner);
    },
  });
  // Quests and dialog (P1, slice 4): the quests module builds the service
  // from this config during assembly. See modules/quests/server.js.
  const questsConfig = {
    questDir: process.env.MMO_QUESTS || DEFAULT_QUEST_DIR,
    dataDir: DATA_DIR,
    getSpeciesNear: () => Object.entries(game.rules.creatures.creatures).map(([id, c]) => ({ id, name: c.name })),
    getItemBases: () => Object.keys(game.rules.items.bases).filter((b) => itemsOf().defs.ofBase(b).length > 0),
    countInBag: (character: number, base: string) => itemsOf().countBase(character, base),
    grantItem: (character: number, base: string) => {
      const def = itemsOf().resolveBase(base);
      return def >= 0 && itemsOf().grantItem(character, def);
    },
    grantGold: (character: number, amount: number) => {
      walletHolder.current?.grant(character, amount, sim.currentTick);
    },
  };
  // A scene's nodes spawn through the creature, prop, item and quest paths (EA6, data-driven entities).
  // After items and quests exist, so item and quest nodes have somewhere to go: this runs once the systems are assembled.
  const spawnBootScene = (): void => {
  if (process.env.MMO_SCENE) {
    const scene = loadSceneFile(process.env.MMO_SCENES || process.env.MMO_SCENES_DIR || DEFAULT_SCENES_DIR, process.env.MMO_SCENE);
    const prefabs = loadPrefabs(process.env.MMO_PREFABS || DEFAULT_PREFABS_DIR);
    const r = spawnSceneOnBoot(
      scene,
      {
        sim,
        creatures: creaturesOf(),
        table: () => loadScatterContent().table,
        scale,
        bounds: fs.existsSync(ART_CATALOG) ? catalogBounds(ART_CATALOG) : undefined,
        groundHeightAt: (x, z) => characterOf().groundHeight(x, z),
        // Buildings and land props refuse to stand in the water (habitat.ts).
        seaLevel: seaLevelMeta === null ? undefined : Number(seaLevelMeta),
        waterAt: water ?? undefined,
        riverAt: tiles.getMap("river") ? riverAtFromMap(tiles.getMap("river")!) : undefined,
        prefabs,
        species: (id) => speciesRoster.roster[id],
        items: {
          place: (base, rank, x, z) => {
            const def = lineDef(itemsOf().defs, { base, rank }, rankOrder);
            return def < 0 ? null : itemsOf().placeFixture(sim, def, x, z);
          },
          discard: (ids) => ids.forEach((i) => itemsOf().discardGround(sim, i)),
        },
        resources: { register: (eid, key, spec) => gathering.register(eid, key, spec) },
        chests: { register: (eid, key, spec) => chests.register(eid, key, spec, sim) },
        breakables: { register: (eid, key, def) => breaks.register(sim, eid, key, def) },
        structureBreakable: (kind) => structureKinds.get(kind),
        vendors: {
          attach: (eid, template) => {
            const vs = assembled.byName["vendor"] as unknown as import("./economy/vendor.js").VendorSystem | undefined;
            if (!vs) return "this server has no economy";
            const t = vendorTemplates.get(template);
            if (!t) return `no vendor template "${template}"`;
            if (!vs.templateIds().includes(template)) {
              vs.define({
                id: template,
                name: t.name,
                buybackRate: t.buybackRate,
                stock: t.stock.flatMap((l) => {
                  const def = lineDef(itemsOf().defs, { base: l.base, rank: l.rank }, rankOrder);
                  return def < 0 ? [] : [{ def, price: l.price, quantity: l.quantity }];
                }),
              });
            }
            return vs.attach(eid, template) ? null : "could not attach";
          },
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
  };
  // Dungeon instances (D4): the gateway's "dungeon" extension starts a
  // sandbox gateway per run from the prebaked pool and commits its result.
  // Slice 3: the dungeons module builds the pool, the InstanceManager, and
  // the instance-result store from this config during assembly. See
  // modules/dungeons/server.js. The character and instance-result stores
  // now live on moduleCtx.stores (built by the character/dungeons modules);
  // train reads the character store lazily — it only runs during live runs.
  const dungeonsConfig = {
    dungeonDir: process.env.MMO_DUNGEONS || DEFAULT_DUNGEON_CONTENT,
    dataDir: DATA_DIR,
    instanceHost: process.env.MMO_INSTANCE_HOST || "localhost",
    getGame: () => game,
    credentialStore,
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
    grantItem: (character: number, def: number) => itemsOf().grantItem(character, def),
    train: (character: number, skill: string, difficulty: number, key: number) => {
      const i = masteryOf().index.of(skill);
      if (i < 0) return;
      const sheet = new SkillSheet(masteryOf().index);
      const saved = characterStore?.loadSkills?.(character);
      if (saved) sheet.load(saved);
      sheet.train(i, difficulty, key, Date.now());
      characterStore?.saveSkills?.(character, sheet.save());
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
    // A building holds out against a blow from anyone below its minStrength (IX6).
    canBreak: (attacker: number, target: number): boolean => breaks.canHit(sim, attacker, target),
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
    // Blow resolution (EG6): read each strike, so a rules reload applies at once.
    getCombatTuning: () => ({ resolution: game.rules.combat.resolution, unarmed: game.rules.items.unarmed }),
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
  // The module context outlives the assembly call: modules publish domain
  // stores on ctx.stores during createSystems (character, social, dungeons,
  // economy), and server.ts reads them back post-assembly below.
  // The towns' people (SG3b): the boot scene's structure positions by node id (a structure's node id is its structure id), and the baked manifests.
  const residentsConfig = {
    structurePositions: (): Map<string, { x: number; z: number }> | null => {
      if (!process.env.MMO_SCENE) return null;
      const prefabs = loadPrefabs(process.env.MMO_PREFABS || DEFAULT_PREFABS_DIR);
      const doc = expandPrefabs(loadSceneFile(process.env.MMO_SCENES || DEFAULT_SCENES_DIR, process.env.MMO_SCENE), prefabs).doc;
      return new Map(worldNodes(doc).map((w) => [w.node.id, { x: w.position[0], z: w.position[2] }]));
    },
    manifestsDir: process.env.MMO_SETTLEMENTS || path.join(REPO_ROOT, "content", "settlements"),
    catalog: characterCatalog,
    timeOfDay: dayClock ? (tick: number) => timeOfDayAt(dayClock, tick, 30) : undefined,
    groundHeightAt: (x: number, z: number) => characterOf().groundHeight(x, z),
    maxEntities: Number(process.env.MMO_RESIDENTS_MAX ?? 800),
  };
  const moduleCtx: ServerModuleContext = {
    sim,
    log: (m) => console.log(m),
    // Slices 2-6: modules read their bootstrap config from here.
    config: { items: itemsConfig, dungeons: dungeonsConfig, quests: questsConfig, combat: combatConfig, creatures: creaturesConfig, character: characterConfig, physics: physicsConfig, economy: { dataDir: DATA_DIR, itemsOf }, social: { dataDir: DATA_DIR }, residents: residentsConfig },
  };
  const assembled = await assembleServerSystems({
    modulesDir: path.join(REPO_ROOT, "modules"),
    setFile: process.env.MMO_MODULES || path.join(REPO_ROOT, "content", "modules.json"),
    provided: {
      core: {
        reloader,
        streamer,
        gathering,
        chests,
        breaks,
      },
    },
    ctx: moduleCtx,
  }).catch((err: Error) => {
    console.error(`[server] ${err.message}`);
    process.exit(1);
  });
  // Slices 2-5: items, dropper, dungeons, quests, and the combat cluster
  // come from their modules.
  itemsRef = assembled.byName["items"] as import("./items/index.js").ItemService;
  // The economy module owns the wallet; pre-assembly configs use it lazily.
  walletHolder.current = assembled.byName["wallet"] as import("./economy/wallet.js").WalletSystem;
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
  (startWild as (() => void) | null)?.();
  // Physics domain (slice 8).
  physicsRef = assembled.byName["physics"] as unknown as { terrainColliders(s: number): (...a: unknown[]) => unknown };
  // Character domain (slice 7).
  characterRef = {
    character: assembled.byName["character"] as unknown as import("./index.js").CharacterSystem,
    mastery: assembled.byName["mastery"] as unknown as import("./stats/mastery-system.js").MasterySystem,
  };
  // Domain stores, built by their modules during assembly and published on
  // moduleCtx.stores: the gateway consumes them below. Undefined when the
  // owning module is disabled — the gateway falls back to its in-memory
  // defaults, and the dungeon reporter skips when the dungeons module is off.
  const characterStore = moduleCtx.stores!.characterStore as import("./characters/index.js").SqliteCharacterStore | undefined;
  // Persistence P4: the world character sync needs one concrete store.
  // When the character module is disabled, share a single in-memory
  // store between the gateway and the sync (the gateway's own fallback
  // would be a second, divergent instance).
  const effectiveCharacterStore = characterStore ?? new MemoryCharacterStore();
  const guildStore = moduleCtx.stores!.guildStore as import("./guild-store.js").SqliteGuildStore | undefined;
  const socialStore = moduleCtx.stores!.socialStore as import("./index.js").SqliteSocialStore | undefined;
  const partyStore = moduleCtx.stores!.partyStore as import("./index.js").SqlitePartyStore | undefined;
  const instanceResults = moduleCtx.stores!.instanceResults as import("./dungeons/results.js").SqliteInstanceResultStore | undefined;
  const questStore = moduleCtx.stores!.questStore as import("./quests/quest-store.js").SqliteQuestStore | undefined;
  // PL3c: guilds, parties, friends and blocks are world records; the local stores are seeded from them
  // here, before the gateway's books read them, and written through the sync's tracked stores after.
  const socialSync =
    worldClient?.registered && guildStore && partyStore && socialStore
      ? new SocialWorldSync({
          client: worldClient,
          guilds: guildStore,
          parties: partyStore,
          social: socialStore,
          reload: (kind) => gw.reloadSocial(kind),
          log: (line) => console.log(`[server] ${line}`),
        })
      : null;
  await socialSync?.boot();
  spawnBootScene();
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
  // was assigned during the fleet boot block when WORLD_URL is set; these closures
  // only run once players are around, long after.
  // Persistence P4: global characters at the world tier. Only in
  // fleet mode and only when this boot's registration landed (the
  // sync rides the same single WorldClient as recall, the shipper
  // and the migration coordinator; its character ops need the lease).
  // Standalone mode passes nothing and is byte-identical.
  // Atomic operations A2: with a registered client, the character
  // sync also carries the economy projection (wallet + bags) so the
  // world record holds gold + inventory, and the atomic-ops
  // coordinator routes trade/vendor/auction/grant commits through
  // the world ops, fenced by the sync's session locks. Standalone
  // mode constructs neither (byte-identical).
  const economyView = worldClient?.registered
    ? new LocalEconomyView({
        wallet: walletHolder.current as import("./economy/wallet.js").WalletSystem,
        store: itemsOf().store,
        durabilityOf: (def) => itemsOf().defs.durability[def] ?? 100,
      })
    : null;
  const worldCharacters =
    worldClient?.registered
      ? new WorldCharacterSync({
          client: worldClient,
          store: effectiveCharacterStore,
          economy: economyView ?? undefined,
          // PL3b: the character's quest log and pouch ride its world record, so they follow it to any region.
          extras: {
            extrasOf: (id) => ({ ...(questStore ? { quests: questStore.load(id) } : {}), pouch: gatheringStore.loadPouch(id) }),
            seed: (id, extras) => {
              if (questStore && extras.quests !== undefined) questStore.replace(id, questRecordsOf(extras.quests));
              if (extras.pouch !== undefined) {
                gatheringStore.replacePouch(id, materialCountsOf(extras.pouch));
                gathering.forgetPouch(id);
              }
            },
          },
          log: (line) => console.log(`[server] ${line}`),
        })
      : null;
  const atomicOps = worldCharacters && worldClient?.registered
    ? new WorldAtomicOps({ client: worldClient, fences: worldCharacters })
    : null;
  if (atomicOps) atomicOpsRef.ops = atomicOps;
  // E3b: with MMO_EDGE=1 the players' sockets are the edge's, relayed over the core channel (started below).
  const toEdge: { push: EdgePush } = { push: () => {} };
  const edgeRelay = EDGE_MODE ? new ChannelTransport((type, payload) => toEdge.push(type, payload), coreChannelPort()) : null;
  const gw: Gateway = new Gateway({
    port: PORT,
    ...(edgeRelay ? { transport: edgeRelay } : {}),
    scale,
    sessionStore,
    worldCharacters: worldCharacters ?? undefined,
    atomicOps: atomicOps ?? undefined,
    // Chat rules from the chat module (slice 1: the gateway no longer imports
    // chat rules directly). Falls back to built-ins if the module is absent.
    chatRules: await loadChatRules(),
    // Party, guild, chat and slot limits (EG9); a rules reload swaps them.
    social: game.rules.social,
    needs: game.rules.needs,
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
    // Interest management: on unless MMO_INTEREST=0 (dungeon instances run their own gateway, which sees everything).
    ...(process.env.MMO_INTEREST === "0" ? {} : { interest: game.rules.interest }),
    world: sim,
    // The streamer runs first: chunks it loads this tick are in this
    // tick's delta, and physics picks up their bodies in the same tick.
    systems: assembled.systems,
    extensions: [quests, dungeons, craftingService],
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
    characterStore: effectiveCharacterStore,
    guildStore: socialSync?.guildStore ?? guildStore,
    socialStore: socialSync?.socialStore ?? socialStore,
    partyStore: socialSync?.partyStore ?? partyStore,
    characterCatalog,
    playerAbilities,
    dayClock: dayClock ?? undefined,
    startTick: freshBoot ? 1 : restoredTick! + 1,
    // Terrain-height channel (slice 4.1): the gateway attaches authoritative
    // 16x16 heights to chunk rows on network snapshots/deltas. The
    // persistence path never sees them (SnapshotStore collects separately).
    chunkSource: procgen,
    // On-demand chunk tiles (0x22/0x23) are generated from this seed.
    worldSeed,
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

  // ---- world server: migration + presence (region) ----------------------
  // Registration + P3 recall already happened above, before the world
  // was restored (see the fleet boot block); the client created there
  // is reused here, still carrying this boot's epoch. Everything here
  // runs off the tick loop: heartbeat timer -> snapshot reports ->
  // migration/presence timers. A slow or dead world server must never
  // stall the sim.
  let migrationTimer: NodeJS.Timeout | null = null;
  let presenceTimer: NodeJS.Timeout | null = null;
  if (WORLD_URL && worldClient) {
    // The range migration treats as ours: the explicit range, or the
    // world-assigned range (P5); the long-standing default when an
    // assigned shard's registration failed and no range was granted.
    const chunkRange = fleetChunkRange ?? { x0: 0, x1: 4096, z0: 0, z1: 4096 };
    // Border hand-offs (WORLD-SERVER-SPEC §6): players walking into another
    // live region's chunks are handed to it; off the tick, 4 times a second.
    const migration = new MigrationCoordinator({
      world: worldClient,
      host: gw.migrationHost(),
      chunkRange,
      chunkSize: CHUNK_SIZE,
      log: (line) => console.log(`[server] ${line}`),
    });
    migrationCoordinator = migration;
    const coordinator = migration;
    coordinator.onEvent((e) => console.log(`[server] migration ${e.kind} ${e.entityId} ${e.migrationId}`));
    gw.setMigrationAcceptor((id, verify) => coordinator.accept(id, false, verify));
    if (worldClient.registered) {
      await coordinator.refreshRegistry().catch(() => {});
      // Cross-region view (IM8): neighbours from the registry, tickets signed with the fleet key.
      const toRect = (r: { x0: number; x1: number; z0: number; z1: number }) => ({ x0: r.x0 * CHUNK_SIZE, x1: r.x1 * CHUNK_SIZE, z0: r.z0 * CHUNK_SIZE, z1: r.z1 * CHUNK_SIZE });
      const borderKey = process.env.WORLD_API_KEY ?? "";
      migrationTimer = setInterval(() => {
        void coordinator.observe(gw.migrationPositions()).catch((err: unknown) =>
          console.warn(`[server] migration observe: ${(err as Error).message}`));
        if (borderKey) {
          gw.setBorders(
            { regionId: worldClient!.regionId, key: borderKey, rect: toRect(chunkRange) },
            coordinator.knownRegions.filter((r) => r.live).map((r) => ({ regionId: r.regionId, endpoint: r.endpoint, rect: toRect(r.chunkRange) })),
          );
        }
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
    }
  }

  // Persistence P2: write-through to the world store (ledger streaming +
  // snapshot upload), riding the save timer below. Exists only with a
  // world client; standalone mode has no shipper and is unchanged. The
  // shipper reads the client's epoch per write, and recall has already
  // completed, so its writes carry the post-boot (registration) epoch.
  const stateShipper = worldClient
    ? new ShardStateShipper({
        client: worldClient,
        ledger: itemLedger,
        snapshotIntervalTicks: SNAPSHOT_UPLOAD_EVERY_TICKS,
        log: (line) => console.log(`[server] ${line}`),
        // The range's place state outside the ECS rides each snapshot (PL3a); recall seeds it back.
        places: () => ({ resource_nodes: gatheringStore.allNodes(), place_records: placesStore.all() }),
      })
    : null;

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
        // Persistence P2 (Tier 2): offer the checkpoint just saved to
        // the shipper, with the same digest and the exact bytes
        // saveWorld persisted. The shipper uploads it at this range's
        // phase offset inside the checkpoint interval — not now — and
        // skips it entirely if the content is unchanged.
        stateShipper?.offerSnapshot(result.tick, digest, result.snapshotBytes);
        // Dungeon runs (D4): fold the committed batch into the next world
        // report. Rows stay unreported until the world confirms them
        // ingested, so a failed flush retries on the next save. Skipped
        // while one is in flight: a hung world must not stack up POSTs.
        // instanceResults is absent when the dungeons module is disabled.
        if (!dungeonFlushInFlight && instanceResults) {
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
    // Persistence P2 (Tier 1 + due Tier 2): after the local flush above,
    // ship the ledger outbox uphill and any snapshot whose phase slot
    // has arrived. Fire-and-forget like the dungeon report: the shipper
    // coalesces overlapping pumps and never throws, so a dead world
    // costs durability lag, never simulation time.
    if (stateShipper && worldClient?.registered) {
      void stateShipper.pump(gw.serverTick);
    }
    // PL3c: changed guilds, parties, friends and blocks go uphill on the same cycle.
    void socialSync?.push();
  }, 1000);
  saveTimer.unref();
  if (socialSync) {
    gw.socialIds("guild", () => socialSync.takeId("guild"));
    gw.socialIds("party", () => socialSync.takeId("party"));
    // Other regions' changes arrive within a minute.
    setInterval(() => void socialSync.refresh(), 60_000).unref();
  }

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
  // The edge's channel (E3), up before the gateway listens. With MMO_EDGE=1 the
  // players come through it, so it must bind; otherwise it serves the edge
  // beside the player port, and a core that cannot bind it still serves players.
  const channelPort = coreChannelPort();
  const coreChannel = await startCoreChannel(gw, channelPort, {}, undefined, edgeRelay ?? undefined).catch((err: Error) => {
    if (edgeRelay) throw new Error(`MMO_EDGE=1 needs the core channel on 127.0.0.1:${channelPort}: ${err.message}`);
    console.warn(`[server] core channel not serving on 127.0.0.1:${channelPort}: ${err.message}`);
    return null;
  });
  if (coreChannel) {
    toEdge.push = (type, payload) => coreChannel.server.pushToAll(type, payload);
    console.log(`[server] core channel on 127.0.0.1:${channelPort} (edge/core split)`);
  }
  const port = await gw.listen();
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
  if (edgeRelay) console.log(`[server] listening on the edge: players connect to the edge's game port, relayed over the core channel :${port}; no player port here`);
  else console.log(`[server] listening on ws://0.0.0.0:${port} via ${gw.transportName === "uws" ? "uWebSockets.js" : "ws"}${pcg ? ` (+ webrpc http://0.0.0.0:${port}/rpc/Pcg)` : ""}`);
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
