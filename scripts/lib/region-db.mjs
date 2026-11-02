// The region's local database is region.db (a hot cache of the world; see
// packages/engine-core/src/persist/region-db.ts). Earlier builds wrote world.db.
// This mirrors migrateLegacyRegionDb in TypeScript: rename a legacy file, with
// its sidecars and backups, when region.db does not exist yet.
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export const REGION_DB_FILE = "region.db";
const LEGACY = "world.db";

export function migrateLegacyRegionDb(dataDir) {
  const legacy = join(dataDir, LEGACY);
  const current = join(dataDir, REGION_DB_FILE);
  if (!existsSync(legacy) || existsSync(current)) return "none";
  for (const s of ["", "-wal", "-shm"]) {
    if (existsSync(`${legacy}${s}`)) renameSync(`${legacy}${s}`, `${current}${s}`);
  }
  for (const s of ["", "-wal", "-shm", "-absent"]) {
    if (existsSync(`${legacy}.bak${s}`)) renameSync(`${legacy}.bak${s}`, `${current}.bak${s}`);
  }
  return "renamed";
}
