/**
 * Production server entry (Phase 3): `npm run server`.
 *
 * Wires the full authoritative stack in one Node process:
 *   SimWorld + ChunkStreamer (chunks, scatter, and navmesh tiles load
 *   around players and unload behind them) + IntentSystem +
 *   IntegrateSystem + Jolt PhysicsSystem + Recast NavigationSystem,
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
 *   MMO_SCATTER    what grows on new chunks: "ecology" (natural placement of
 *                  the Synty nature set, content/ecology/wilds.ecology.json)
 *                  or "pcg" (the PCG forest graph with PICG trees). Default:
 *                  ecology when the art is on this machine, else pcg.
 *   MMO_ECOLOGY    an ecology plan file (default: content/ecology/wilds.ecology.json)
 *   MMO_BOTS       computer-driven characters near the spawn point (default 0):
 *                  sparring pairs and wanderers, with random looks
 *   MMO_BOTS_HOME  "x,z" where they gather (default: beside the spawn point)
 *   MMO_BOTS_RADIUS how far from home they roam, metres (default 18)
 *   MMO_PLAYER_ABILITIES what new players can do: "swim" (default), or
 *                  "swim,fly" (flight is for expansions; "none" = walk only)
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
import { fileURLToPath } from "node:url";
import {
  Gateway,
  despawnSessionlessAvatars,
  SimWorld,
  IntentSystem,
  CharacterSystem,
  IntegrateSystem,
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
  waterSurfaceFromMaps,
  type ChunkBounds,
} from "./index.js";
import { Ability, type DayClock } from "@mmo-engine/protocol";
import { worldInfoFor } from "./terrain/world-info.js";
import { startPcgService } from "./pcg/boot.js";
import { RulesError } from "@mmo-engine/rules";
import { DEFAULT_LADDER } from "@mmo-engine/compose";
import { loadGameRules, type GameRules } from "./rules/boot.js";
import { HooksDelegate, RulesReloader } from "./rules/reload.js";
import { CombatSystem, type CombatSkills, type Weapon } from "./combat.js";
import { BodySystem } from "./body.js";
import { DeathSystem } from "./death.js";
import { hasComponent } from "bitecs";
import { CharacterRef } from "./components.js";
import { StatsSystem } from "./stats/stats-system.js";
import { NeedsSystem } from "./stats/needs-system.js";
import { MasterySystem } from "./stats/mastery-system.js";
import { StaminaSystem } from "./stats/stamina-system.js";
import { BotSystem } from "./bots.js";
import { CrowdSystem } from "./navigation/crowd-system.js";
import { CreatureSystem } from "./creatures.js";
import { NavObstacleSystem } from "./navigation/obstacle-system.js";
import { TILE_CACHE_SETTINGS } from "./navigation/chunk-baker.js";
import { SqliteGuildStore } from "./guild-store.js";
import { SqliteSocialStore } from "./social-store.js";
import { loadCharacterCatalog, SqliteCharacterStore } from "./characters/index.js";
import { makeWorldPopulator } from "./procgen/world-populator.js";
import { FormationTileStore } from "./persist/formation-tiles.js";
import { ItemLedger } from "./persist/item-ledger.js";
import { biomeLookup } from "./terrain/biome-lookup.js";
import { ItemService, LootDropper, loadItemDefs } from "./items/index.js";

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

  // ---- native systems ----------------------------------------------------
  const physics = new PhysicsSystem(createJoltBackend());
  const navBackend = createNavigationBackend({
    originX: 0,
    originZ: 0,
    tileWorldSize: CHUNK_SIZE,
    profiles: [{ id: 0, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9 }],
    // One tile per loaded chunk (up to ~441 per player while streaming).
    // Poly refs are 32-bit: tile bits + poly bits must stay <= 22. A 16 m
    // terrain tile holds a few dozen polys, more round the obstacles cut
    // into it: 8192 tiles (13 bits) x 512 polys (9 bits).
    maxTiles: 8192,
    maxPolys: 512,
    // Tiles are built from layers plus obstacles: every static body cuts
    // the navmesh (NavObstacleSystem), so walkers go round trees and rocks.
    tileCache: TILE_CACHE_SETTINGS,
  });
  const obstacles = new NavObstacleSystem(navBackend.tileCache!, { chunkWorldSize: CHUNK_SIZE, agentRadius: TILE_CACHE_SETTINGS.agentRadius });
  const navigation = new NavigationSystem({ backend: navBackend });

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
  const spawn = spawnMeta ? (JSON.parse(spawnMeta) as { x: number; z: number }) : { x: 0, z: 0 };
  const scx = Math.floor(spawn.x / CHUNK_SIZE);
  const scz = Math.floor(spawn.z / CHUNK_SIZE);
  const area: Array<[number, number]> = [];
  for (let dz = -WORLD_RADIUS; dz <= WORLD_RADIUS; dz++) {
    for (let dx = -WORLD_RADIUS; dx <= WORLD_RADIUS; dx++) area.push([scx + dx, scz + dz]);
  }
  const boundsMeta = store.getMeta("world_bounds");
  let bounds: ChunkBounds;
  if (boundsMeta) {
    const { minChunk, maxChunk } = JSON.parse(boundsMeta) as { minChunk: number; maxChunk: number };
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
  const chunkNavmesh = new ChunkNavmesh({
    backend: navBackend,
    registry,
    registryDir: navmeshDir,
    source: procgen,
    seed: worldSeed,
    chunkWorldSize: CHUNK_SIZE,
    // New tiles bake off the tick thread (5-40 ms each on first visit).
    worker: true,
    onLoaded: (cx, cz) => obstacles.tileLoaded(cx, cz),
  });
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
  // What grows on new chunks (see world-populator: ecology or PCG).
  const populator = makeWorldPopulator({
    worldSeed,
    chunkWorldSize: CHUNK_SIZE,
    seaLevel: seaLevelMeta === null ? undefined : Number(seaLevelMeta),
    biomeAt: biomeLookup(store, tiles) ?? undefined,
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
    navmesh: chunkNavmesh,
    // Each loaded chunk is static ground for physics bodies.
    colliders: physics.terrainColliders(CHUNK_SIZE),
    bounds,
    pinned: area,
    loadRadius: STREAM_RADIUS,
  });
  const adopted = streamer.adopt(sim);
  const warmed = streamer.warm(sim);
  console.log(
    `[stream] ${adopted} chunk(s) restored, ${warmed} loaded for the spawn area; ` +
      `radius ${STREAM_RADIUS} around players, world chunks ${bounds.minCx}..${bounds.maxCx} x ${bounds.minCz}..${bounds.maxCz} ` +
      `(scatter plan ${populator.planHash.slice(0, 12)}…)`,
  );

  // ---- auth + gateway ----------------------------------------------------
  const credentialStore = new CsvCredentialStore(
    path.join(DATA_DIR, "users.csv"),
  );
  const characterStore = new SqliteCharacterStore(path.join(DATA_DIR, "characters.db"));
  const guildStore = new SqliteGuildStore(path.join(DATA_DIR, "guilds.db"));
  const socialStore = new SqliteSocialStore(path.join(DATA_DIR, "social.db"));
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
  const character = new CharacterSystem({
    onLand: (e, speed) => void bodyRef?.applyFall(sim, e, speed),
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
  });
  // Bots: they live in the world through the same systems as players.
  const botCount = Number(process.env.MMO_BOTS ?? 0);
  const botHome = process.env.MMO_BOTS_HOME?.split(",").map(Number);
  const bots =
    botCount > 0
      ? [
          new BotSystem({
            count: botCount,
            home: botHome && botHome.length === 2 ? { x: botHome[0], z: botHome[1] } : { x: spawn.x + 6, z: spawn.z + 10 },
            radius: process.env.MMO_BOTS_RADIUS ? Number(process.env.MMO_BOTS_RADIUS) : undefined,
            catalog: characterCatalog,
            groundHeightAt: (x, z) => character.groundHeight(x, z),
            abilities: playerAbilities,
            // Wanderers walk the navmesh with the crowd (below).
            steer: navBackend.crowd !== undefined,
          }),
        ]
      : [];
  // Crowd steering: every character is an agent; bots with targets are steered round walls and each other.
  const crowd = navBackend.crowd ? [new CrowdSystem(navBackend.crowd)] : [];
  // Creatures (AI1): one instance, shared by the tick list, combat, death and
  // the gateway's admin spawn.
  const creatures = new CreatureSystem({
    creatures: game.rules.creatures.creatures,
    bases: game.rules.items.bases,
    groundHeightAt: (x, z) => character.groundHeight(x, z),
    steer: navBackend.crowd !== undefined,
  });
  if (botCount > 0) console.log(`[bots] ${botCount} bots (sparring pairs and wanderers)`);
  // Stamina gating: CombatSystem spends move costs through it; the pool
  // itself drains and regens the tick after combat ran.
  const stamina = new StaminaSystem();
  const needs = new NeedsSystem(game.rules.needs);
  const mastery = new MasterySystem(game.rules.skills);
  // Items (roadmap M3a): definitions from the baked loot pool joined with
  // the rules' physics. One instance: the gateway routes item messages to
  // it, and it is in the systems list (it expires ground items).
  const itemDefs = loadItemDefs(DATA_DIR, game.rules);
  console.log(`[${itemDefs.summary}]`);
  const items = new ItemService({
    defs: itemDefs.defs,
    loot: game.rules.loot,
    tickHz: 30,
    groundHeightAt: (x, z) => character.groundHeight(x, z),
    rankOrder: DEFAULT_LADDER.ranks.map((r) => r.id),
  });
  // The ledger owns items: ground entities a restored snapshot left are
  // dropped, then every item comes back from the ledger (bags, hands, ground).
  const strays = items.clearStrayGroundItems(sim);
  if (strays > 0) console.log(`[items] cleared ${strays} ground item(s) left from before the restart`);
  const restored = items.restore(sim, itemLedger.load());
  items.attachLedger(itemLedger);
  if (restored > 0) console.log(`[items] restored ${restored} item(s) from the ledger`);
  // What a character swings: the item in the main hand, by the character's
  // id on its avatar. Bots and props hold nothing (fists).
  const weaponOf = (e: number): Weapon | null => {
    if (!hasComponent(sim.ecs, CharacterRef, e)) return creatures.weaponOf(e);
    const def = items.mainHandDef(CharacterRef.idHi[e] * 4294967296 + CharacterRef.idLo[e]);
    if (def < 0) return null;
    const d = itemDefs.defs;
    return {
      technique: d.technique[def],
      item: { mass: d.mass[def], edge: d.edge[def], point: d.point[def], hardness: d.hardness[def] },
      reach: d.length[def],
    };
  };
  // Creature drops (L2): rolled when DeathSystem records a creature's death.
  const dropper = new LootDropper({ items, defs: itemDefs.defs, creatures: game.rules.creatures.creatures, kindOf: (e) => creatures.kindOf(e) });
  // Rules hot reload (ED1): combat and death hold the delegate, and a
  // reload (validated off the tick, applied first thing in one) swaps the
  // hooks behind it and pushes the new tables into the systems.
  const hooks = new HooksDelegate(game.hooks);
  const reloader = new RulesReloader(game.dir, (g) => {
    game = g;
    hooks.current = g.hooks;
    creatures.setRules(g.rules.creatures.creatures, g.rules.items.bases);
    dropper.setCreatures(g.rules.creatures.creatures);
    items.setLoot(g.rules.loot);
    itemDefs.defs.applyRules(g.rules);
    bodyRef?.setRules(sim, g.rules.body, g.rules.appearance);
    console.log(`[rules] reloaded: ${g.summary}`);
  });
  const combatSkills: CombatSkills = {
    get: (e, id) => mastery.sheetOf(e).get(id),
    train: (e, id, difficulty, key) => {
      const i = mastery.index.of(id);
      if (i >= 0) mastery.sheetOf(e).train(i, difficulty, key, Date.now());
    },
    techniqueSkill: (t) => game.rules.combat.techniques[t]?.skill,
  };
  // Body parts (M2): blows land on parts, wounds bleed, injuries slow and weaken.
  const body = new BodySystem(game.rules.body, hooks, game.rules.appearance);
  bodyRef = body;
  const combat = new CombatSystem(30, stamina, { hooks, weaponOf, skills: combatSkills, body });
  // Players come back at the spawn point (placement lives in the gateway,
  // which owns the spawn grid); bots rise where they fell.
  const death: DeathSystem = new DeathSystem(hooks, 30, (e) => combat.lastAttacker(e), (s, e): boolean => creatures.place(s, e) || (gw as Gateway).respawnPlayer(s, e), (e) => creatures.respawnSeconds(e), (s, ev) => dropper.onDeath(s, ev), body);
  const gw: Gateway = new Gateway({
    port: PORT,
    // The same instance as in the systems list below: its sheets are what get saved.
    mastery,
    body,
    // Per-session intent/pickup budgets and the frame cap (roadmap T1).
    ingress: game.rules.ingress,
    world: sim,
    // The streamer runs first: chunks it loads this tick are in this
    // tick's delta, and physics picks up their bodies in the same tick.
    systems: [reloader, new StatsSystem(), streamer, ...bots, creatures, ...crowd, new IntentSystem(), combat, body, death, stamina, needs, mastery, new IntegrateSystem(), character, new ColliderSystem(), obstacles, physics, navigation, items],
    items,
    // Players spawn standing on the terrain (a baked world's ground is
    // anywhere from a swamp floor below 0 to mountain tops).
    groundHeightAt: (x, z) => character.groundHeight(x, z),
    creatures: {
      has: (k) => k in game.rules.creatures.creatures,
      spawnPack: (w, k, x, z) => creatures.spawnPack(w, k, x, z),
      nameOf: (e) => creatures.nameOf(e),
      entities: () => creatures.entities(),
    },
    spawnPoint: spawn,
    // Baked worlds: extent + coarse map for the client's far horizon.
    worldInfo: worldInfoFor(store, tiles, CHUNK_SIZE) ?? undefined,
    credentialStore,
    characterStore,
    guildStore,
    socialStore,
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
      navigation,
      loadedTileBounds: () => chunkNavmesh.bounds(),
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
    itemLedger.flush();
    gw.saveCharacters();
    if (gw.serverTick >= nextSaveTick) {
      const result = store.saveWorld(gw.serverTick, sim);
      const st = streamer.stats;
      console.log(
        `[server] saved tick ${result.tick} (${result.entityCount} entities, ${result.bytes} B, ${result.ms.toFixed(1)} ms) | ` +
          `chunks ${st.loaded} loaded, ${st.queued} queued, ${st.loads} loads / ${st.unloads} unloads, navmesh ${chunkNavmesh.size} tile(s)`,
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
      gw.saveCharacters();
      itemLedger.flush();
      itemLedger.close();
      // Best-effort deregister; the world's stale-region reaper is the
      // backstop if this doesn't land before exit.
      void worldClient?.stop();
      reloader.close();
    },
  });

  // PCG assets: the Pcg webrpc service on the game port (pcg.ridl).
  const pcg = startPcgService(gw, process.env.MMO_PCG_ASSETS || undefined);
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
  console.log(`[server] listening on ws://0.0.0.0:${port} via ${gw.transportName === "uws" ? "uWebSockets.js" : "ws"}${pcg ? ` (+ webrpc http://0.0.0.0:${port}/rpc/Pcg)` : ""}`);
  console.log(`[server] ${pcg ? pcg.summary : "no PCG asset library (MMO_PCG_ASSETS)"}`);
  console.log(
    `[server] ${freshBoot ? "fresh boot" : `restored at tick ${restoredTick}`} | ` +
      `seed ${worldSeed} | chunk ${CHUNK_SIZE}u | ` +
      `terrain ${storedTiles > 0 ? `${storedTiles} stored tile(s)` : `amp ${terrain.amplitude} freq ${terrain.frequency} (v${terrainVersion})`} | ` +
      `spawn (${spawn.x}, ${spawn.z}) | navmesh ${chunkNavmesh.size} tile(s) | ` +
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
