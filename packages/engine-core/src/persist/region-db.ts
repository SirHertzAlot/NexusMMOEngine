/**
 * The region's local database file: region.db.
 *
 * It is an embedded SQLite file (WAL mode) inside the region process. It is
 * a hot cache, not the authority. When WORLD_URL is set, the world server
 * (SurrealDB) is the durable source of truth: the region recalls its state
 * from the world at boot and writes its changes back. Standalone regions
 * (no WORLD_URL) have no world to recall from, so region.db is their only
 * copy.
 *
 * Earlier builds named this file world.db. migrateLegacyRegionDb renames
 * it, with its WAL/SHM sidecars and any play-mode backup, the first time a
 * data directory is opened.
 */
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export const REGION_DB_FILE = "region.db";
/** The name earlier builds used. Only read by the migration. */
export const LEGACY_REGION_DB_FILE = "world.db";

const SIDECARS = ["", "-wal", "-shm"] as const;
const BACKUP_SUFFIXES = ["", "-wal", "-shm", "-absent"] as const;

export type RegionDbMigration = "none" | "renamed" | "both-present";

/**
 * Rename a legacy world.db in dataDir to region.db (with sidecars and any
 * .bak play backup). Does nothing when region.db already exists. Returns
 * "both-present" when both files exist, so the caller can warn: the legacy
 * file is left untouched in that case.
 */
export function migrateLegacyRegionDb(dataDir: string): RegionDbMigration {
  const legacy = join(dataDir, LEGACY_REGION_DB_FILE);
  const current = join(dataDir, REGION_DB_FILE);
  if (!existsSync(legacy)) return "none";
  if (existsSync(current)) return "both-present";
  for (const s of SIDECARS) {
    if (existsSync(`${legacy}${s}`)) renameSync(`${legacy}${s}`, `${current}${s}`);
  }
  for (const s of BACKUP_SUFFIXES) {
    const from = `${legacy}.bak${s}`;
    if (existsSync(from)) renameSync(from, `${current}.bak${s}`);
  }
  return "renamed";
}
