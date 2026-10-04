/**
 * @mmo-engine/engine-core — authoritative server core.
 *
 * Slice 1.2: fixed-timestep tick loop, bitECS world with SoA components,
 * narrow replaceable systems, and FlatBuffers snapshot/delta codecs.
 * The WebSocket gateway (1.3) and SQLite persistence (1.4) build on
 * these without changing the contract pieces below.
 */

export const VERSION = "0.1.0";

export { makeWireEntityId, parseWireEntityId } from "./entity-id.js";
export { MAX_QUEUED_DELTAS } from "./session.js";
export type { ClientSession } from "./session.js";

export { STEP_MS, MAX_STEPS_PER_FRAME, MAX_FRAME_DELTA_MS, TickLoop } from "./tick-loop.js";
export type { TickLoopStats } from "./tick-loop.js";

export {
  Transform,
  Velocity,
  PlayerIntent,
  Chunk,
  Health,
  BodyConfig,
  ShapeKind,
  MotionType,
  COMPONENT_IDS,
  splitU64,
  joinU64,
  PathRequest,
  PathState,
  PathRequestStatus,
  NavAgent,
  NavAgentState,
  MAX_PATH_WAYPOINTS,
  AssetRef,
  Locomotion,
  Appearance,
  Action,
  WorldItem,
} from "./components.js";
export * from "./items/index.js";

export { SimWorld, SimEventEmitter } from "./world.js";
export type { QueuedIntent, SimEventName, SimEventPayload, SimEventHandler, SimWorldOptions } from "./world.js";
export { StatBook, type ModifierSpec, type StatLine } from "./stats/stat-book.js";
export { StatsSystem } from "./stats/stats-system.js";
export { MasterySystem } from "./stats/mastery-system.js";
export { SkillIndex, SkillSheet } from "./stats/mastery.js";

export {
  IntentSystem,
  IntegrateSystem,
  ColliderSystem,
  attachDefaultCollider,
  CHARACTER_CAPSULE,
  moveSpeedFactor,
  CharacterSystem,
  PhysicsSystem,
  createJoltBackend,
  terrainHeightAt,
  PLAYER_SPEED,
  JUMP_SPEED,
  GRAVITY,
  SWIM_SPEED,
  FLY_SPEED,
  SWIM_VERTICAL_SPEED,
  FLY_VERTICAL_SPEED,
  SWIM_DEPTH,
  FLOAT_DEPTH,
  HEAD_HEIGHT,
  BREATH_SECONDS,
  DROWN_DAMAGE_PER_SECOND,
  MAX_FLIGHT_HEIGHT,
} from "./systems.js";
export type { SimSystem, PhysicsBackend, PhysicsAddBatch, WaterSurface } from "./systems.js";
export { waterSurfaceFromMaps } from "./terrain/water-surface.js";

export {
  collectFullState,
  collectDeltaState,
  collectEntitiesState,
  attachChunkHeights,
  encodeSnapshot,
  encodeDelta,
  decodeSnapshot,
  decodeDelta,
  DeltaTracker,
} from "./snapshot.js";
export type {
  TransformRow,
  VelocityRow,
  IntentRow,
  ChunkRow,
  HealthRow,
  BodyConfigRow,
  AssetRefRow,
  LocomotionRow,
  AppearanceRow,
  ActionRow,
  CollectedState,
  DiffResult,
} from "./snapshot.js";

export { stateFromCollected, applyDelta, compareStates } from "./delta-apply.js";
export type { EntityState, WorldState, StateComparison } from "./delta-apply.js";

export { Gateway, despawnSessionlessAvatars } from "./net/gateway.js";
export type { GatewayOptions } from "./net/gateway.js";
export { makeDebugSource } from "./net/debug-source.js";
export type { DebugSource, DebugSourceDeps } from "./net/debug-source.js";
export { encodeIntentMessage, decodeIntentMessage, sanitizeIntent } from "./net/intent.js";
export type { DecodedIntentMessage } from "./net/intent.js";

export {
  CsvCredentialStore,
  DEFAULT_USERS_CSV_PATH,
  USERNAME_RE,
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  HelloCredentialsSchema,
  HelloTokenSchema,
  HelloMigrationSchema,
  parseHello,
  SessionManager,
  AuthRateLimiter,
} from "./auth/index.js";
export type {
  CredentialRecord,
  CredentialStore,
  HelloCredentials,
  HelloToken,
  HelloMigration,
  AuthSession,
  SessionManagerOptions,
  RateLimitOptions,
} from "./auth/index.js";

export {
  makeProcgenChunkSource,
  makeTileChunkSource,
  heightsFingerprint,
  createCachedChunkSource,
  terrainOptionsFromEnv,
  DEFAULT_TERRAIN_AMPLITUDE,
  spawnChunk,
  chunkIdFor,
  chunkCoordsFor,
} from "./procgen/chunk-source.js";
export type {
  ChunkDataSource,
  ProcgenChunkSource,
  TerrainOptions,
} from "./procgen/chunk-source.js";

export {
  makeScatterBinding,
  loadScatterContent,
  scatterChunkToECS,
  scatterSeedU32,
  spawnScatterEntity,
  makeScatterPopulator,
} from "./procgen/scatter-spawn.js";
export type { ScatterBinding, ScatterContent, ScatterChunkOptions } from "./procgen/scatter-spawn.js";

export {
  SnapshotStore,
  DEFAULT_DB_PATH,
  DEFAULT_KEEP_SNAPSHOTS,
  DEFAULT_SAVE_EVERY_TICKS,
  SCHEMA_VERSION,
  installShutdownHook,
  TerrainTileStore,
  SERVER_PID_FILE,
  runningServerPid,
} from "./persist/index.js";
export type {
  SnapshotStoreOptions,
  SaveResult,
  LoadedSnapshot,
  ShutdownStateReader,
  ShutdownHookOptions,
} from "./persist/index.js";

export {
  createNavigationBackend,
  NAV_PATH_STATUS,
} from "./navigation/backend.js";
export type {
  NavigationBackend,
  NavServiceOptions,
  NavAgentProfile,
  BakeTileConfig,
  BakeTileStats,
  BakeTileResult,
  FindPathsInput,
  FindPathsOutput,
  CrowdBackend,
  CrowdAddInput,
  TileCacheBackend,
  TileCacheOptions,
  ObstacleInput,
} from "./navigation/backend.js";

export { NavigationSystem, WaypointStore } from "./navigation/system.js";
export { CrowdSystem } from "./navigation/crowd-system.js";
export { CreatureSystem, type CreatureOptions } from "./creatures.js";
export { NavObstacleSystem } from "./navigation/obstacle-system.js";
export type { NavObstacleOptions } from "./navigation/obstacle-system.js";
export type { NavigationSystemOptions } from "./navigation/system.js";

export {
  bakeChunkTile,
  buildChunkMesh,
  bakeConfigHash,
  canonicalBakeConfig,
  DEFAULT_BAKE_CONFIG,
  bakeChunkLayers,
  buildNeighbourhoodMesh,
  TILE_CACHE_SETTINGS,
  LAYERS_FORMAT,
} from "./navigation/chunk-baker.js";
export type {
  ChunkBakeOptions,
  ChunkBakeResult,
} from "./navigation/chunk-baker.js";

export { NavmeshTileRegistry, tileContentHash } from "./persist/navmesh.js";
export type {
  NavmeshTileKey,
  NavmeshTileRecord,
  NavmeshTileRegistryOptions,
} from "./persist/navmesh.js";

export {
  WorldClient,
  WorldTransportError,
} from "./world/client.js";
export type { WorldTransport, WorldClientOptions } from "./world/client.js";
export { WebrpcWorldTransport } from "./world/webrpc-transport.js";
export { MigrationCoordinator } from "./world/migration.js";
export type {
  EntityPosition,
  MigrationCoordinatorOptions,
  MigrationEvent,
  MigrationHost,
  MigrationWorldApi,
} from "./world/migration.js";

export { ChunkEntityStore } from "./persist/chunk-entities.js";
export type { ChunkEntitiesRow } from "./persist/chunk-entities.js";
export { FormationTileStore, encodeFormationPoints, decodeFormationPoints } from "./persist/formation-tiles.js";
export { ChunkNavmesh } from "./navigation/chunk-navmesh.js";
export type { ChunkNavmeshOptions, ChunkNavmeshLoad } from "./navigation/chunk-navmesh.js";
export { ChunkStreamer, packChunk, unpackChunk } from "./streaming/chunk-streamer.js";
export type {
  ChunkBounds,
  ChunkPopulator,
  ChunkNavmeshHook,
  ChunkColliderHook,
  ChunkStreamerOptions,
  ChunkStreamerStats,
} from "./streaming/chunk-streamer.js";

export {
  CharacterRefusedError,
  CHARACTER_NAME_RE,
  checkNewLook,
  DEFAULT_LOOK_JSON,
  DEFAULT_MAX_CHARACTERS,
  listCharacters,
  loadCharacterCatalog,
  MemoryCharacterStore,
  readCharacterView,
  SqliteCharacterStore,
  summarizeLook,
} from "./characters/index.js";
export type {
  CharacterItemView,
  CharacterItemWhere,
  CharacterListEntry,
  CharacterRecord,
  CharacterStore,
  CharacterView,
  DeathView,
  ItemDefNames,
  LookSummary,
  ReadCharacterViewOptions,
  SavedStateView,
} from "./characters/index.js";
export { SqliteGuildStore } from "./guild-store.js";
export { SqlitePartyStore } from "./party-store.js";
export { memorySocialStore, SqliteSocialStore, type SocialStore } from "./social-store.js";

export { DeathSystem, type LifeEvent } from "./death.js";
export { CombatSystem, GUARD_FACTOR, type CombatDamage, type CombatSkills, FIGHT_DIFFICULTY, type HitEvent, type Weapon } from "./combat.js";

// Edge/core split E3: the core's end of the internal channel.
export {
  startCoreChannel,
  createCoreChannelHandler,
  pushTick,
  isSnapshotTick,
  coreChannelPort,
  SNAPSHOT_EVERY_TICKS,
  createCoreMetrics,
  CORE_METRIC_NAMES,
} from "./channel-server.js";
export type { CoreChannel, CoreChannelHost, CoreMetrics, IntentPayload, MythicHooks } from "./channel-server.js";
export type { GatewayTick } from "./net/gateway.js";
