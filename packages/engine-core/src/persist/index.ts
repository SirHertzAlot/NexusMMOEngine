/** Slice 1.4 persistence: SQLite snapshot store + shutdown hook. */
/** Slice 2.1 (Phase 2): content-addressed navmesh tile registry. */
export {
  SnapshotStore,
  DEFAULT_DB_PATH,
  DEFAULT_KEEP_SNAPSHOTS,
  DEFAULT_SAVE_EVERY_TICKS,
  SCHEMA_VERSION,
} from "./store.js";
export type {
  SnapshotStoreOptions,
  SaveResult,
  LoadedSnapshot,
} from "./store.js";
export { installShutdownHook } from "./shutdown.js";
export type {
  ShutdownStateReader,
  ShutdownHookOptions,
} from "./shutdown.js";
export { NavmeshTileRegistry, tileContentHash } from "./navmesh.js";
export type {
  NavmeshTileKey,
  NavmeshTileRecord,
  NavmeshTileRegistryOptions,
} from "./navmesh.js";
export { TerrainTileStore, SERVER_PID_FILE, runningServerPid } from "./terrain-tiles.js";
export { ItemLedger, LedgerKind } from "./item-ledger.js";
export type { ItemRow, LedgerEventRow, LedgerKindCode } from "./item-ledger.js";
