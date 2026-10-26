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
  encodeSnapshotFromSim,
  encodeDeltaFromSim,
  encodeFastDeltaFromSim,
  encodeSnapshotSoA,
  encodeDeltaSoA,
  decodeSnapshot,
  decodeDelta,
  decodeFastDelta,
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
  CollectedStateSoA,
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
export { loadScale, scaleResolver, type ScaleResolver } from "./scale.js";
export { clearOfStatics, PropCollisionSystem } from "./prop-collision.js";
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
export type {
  WorldTransport,
  WorldClientOptions,
  TradeCommitRequest,
  VendorTransactRequest,
  AuctionSettleRequest,
  CraftExecuteRequest,
  LootGrantRequest,
  InventoryMutateRequest,
} from "./world/client.js";
export {
  WorldAtomicOps,
  LocalEconomyView,
  itemInstanceId,
  parseItemInstanceId,
} from "./world/atomic-ops.js";
export type {
  AtomicWorldClient,
  AtomicFenceSource,
  WorldAtomicOpsOptions,
  LocalEconomyViewOptions,
} from "./world/atomic-ops.js";
export { CraftingService } from "./crafting/crafting-service.js";
export type {
  AtomicCraftExecutor,
  CraftingServiceOptions,
} from "./crafting/crafting-service.js";
export { WebrpcWorldTransport } from "./world/webrpc-transport.js";
export {
  planFleetBoot,
  parseChunkRangeEnv,
  DEFAULT_CHUNK_RANGE,
} from "./world/fleet-boot.js";
export type { FleetBootPlan, FleetBootEnv } from "./world/fleet-boot.js";
export {
  ShardStateShipper,
  LEDGER_BATCH_MAX_EVENTS,
  LEDGER_BATCH_MAX_BYTES,
} from "./world/state-shipper.js";
export type {
  StatePlaneClient,
  ShardStateShipperOptions,
} from "./world/state-shipper.js";
export {
  WorldCharacterSync,
  parseWorldCharacterState,
  seedLocalCharacter,
  worldCharacterPayload,
  economyOfState,
  CHARACTER_LOCK_TTL_MS,
} from "./world/character-sync.js";
export type {
  CharacterWorldClient,
  CharacterLoginResult,
  WorldCharacterState,
  WorldCharacterSyncOptions,
  CharacterEconomyView,
  CharacterExtrasView,
} from "./world/character-sync.js";
export {
  recallShardState,
  unwrapShardSnapshotPayload,
} from "./world/state-recall.js";
export type {
  StateRecallClient,
  ShardRecallOutcome,
  ShardStateRecallOptions,
} from "./world/state-recall.js";
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
export { SqliteFriendStore } from "./friend-store.js";

export { DeathSystem, type DeathBody, type LifeEvent } from "./death.js";
export { Mana, MagicSystem, type SpellEvent } from "./magic.js";
export { BLEEDING_BIT, blowRng, Body, BodySystem, Injury, NO_JUMP, PART_STATES, restoreBody, Wound, type BlowResult, type BodyView, type PartView } from "./body.js";
export { aimFromLookPitch, PITCH_AIM_DEADZONE, PITCH_AIM_HIGH, PITCH_AIM_LOW, CombatSystem, GUARD_FACTOR, type CombatDamage, type CombatSkills, FIGHT_DIFFICULTY, type HitEvent, type Weapon } from "./combat.js";
export { BotSystem } from "./bots.js";
export { AnimationSystem, ensureAnimation } from "./animation.js";
export { loadStrings, t, pseudoLocalize, type Strings } from "./strings.js";
export { loadAudioEvent, loadAudioBank, AudioBus, AudioBank, BusSettings, type AudioEvent } from "./audio.js";

// Edge/core split E3: the core's end of the internal channel.
export {
  startCoreChannel,
  createCoreChannelHandler,
  pushTick,
  coreChannelPort,
  createCoreMetrics,
  CORE_METRIC_NAMES,
} from "./channel-server.js";
export type { CoreChannel, CoreChannelHost, CoreMetrics, IntentPayload, MythicHooks } from "./channel-server.js";
export type { GatewayTick } from "./net/gateway.js";
export { backupWorld, discardBackup, hasBackup, restoreWorld, snapshotPath } from "./world-snapshot.js";
export * from "./server-settings.js";

// Zero-Copy Hybrid Engine Data Plane (ENGINE_IMPLEMENTATION_SPEC.md)
export {
  SAB_ENTITY_CAPACITY,
  DATA_PLANE_ENTITY_CAPACITY,
  BYTES_PER_FLOAT,
  BYTES_PER_INT,
  CACHE_LINE_BYTES,
  SOA_LAYOUT,
  INTENT_FLAGS,
  OFFSETS,
  TELEMETRY_SLOTS,
  alignCacheLine,
  computeArenaOffsets,
  createSharedMemoryPlane,
  attachSharedMemoryPlane,
  syncMatrixToPlanar,
  syncPlanarToMatrix,
  sabBackComponent,
  defineSABComponent,
} from "./sab-store.js";
export type {
  MemoryArenaOffsets,
  PlanarSoAViews,
  SharedMemoryPlaneViews,
} from "./sab-store.js";

export {
  SPSC_CACHE_LINE_BYTES,
  SPSC_HEADER_BYTES,
  packCommandToken,
  unpackCommandToken,
  AtomicSPSCQueue,
  PERSIST_TX_KIND,
  AtomicSPSCTransactionQueue,
} from "./lockless-ring.js";
export type { PersistTxKind, PersistTransaction } from "./lockless-ring.js";

export {
  TICK_RATE_HZ,
  FRAME_BUDGET_MS,
  DT,
  DEFAULT_INPUT_RING_CAPACITY,
  DEFAULT_PERSIST_RING_CAPACITY,
  DEFAULT_BASE_SPEED,
  loadNativeKernel,
  SimWorkerRuntime,
} from "./sim-worker.js";
export type {
  NativeEngineKernel,
  SimExecutionMode,
  SimWorkerConfig,
  SimTickMetrics,
} from "./sim-worker.js";

export {
  PERSIST_SCHEMA_SURREALQL,
  loadPersistSchemaSurrealQL,
  PersistenceWorkerRuntime,
} from "./persist-worker.js";
export type {
  PersistWorkerConfig,
  EntityPersistRecord,
  InventorySlotRecord,
} from "./persist-worker.js";

export {
  DEFAULT_DATA_PLANE_PORT,
  WS_SIM_ROUTE,
  encodeBinaryCommandFrame,
  encodeBinaryCommandBatch,
  HybridDataPlaneServer,
} from "./data-plane-server.js";
export type { HybridDataPlaneOptions } from "./data-plane-server.js";


// PATCH-02, PATCH-03, PATCH-04, PATCH-05 Exports
export {
  MortonSpatialIndex,
  encodeMorton2D,
  decodeMorton2D,
  part1By1,
  compact1By1,
  GenerationalSlabAllocator,
  packEntityHandle,
  unpackEntityHandle,
  writeEntityStateToSAB,
  readEntityStateFromSAB,
  setEntityAliveBit,
  type EntitySnapshot,
} from "./sab-store.js";

export {
  AtomicMPSCQueue,
  DEFAULT_RING_CAPACITY,
  COMMAND_SLOT_UINT32_STRIDE,
} from "./lockless-ring.js";
