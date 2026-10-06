/**
 * SurrealDB-backed WorldStore. Connects to a SurrealDB server over
 * ws:// (see `npm run db` — the world server does NOT embed the DB;
 * WASM-embedded in Node is memory-only and the npm package doesn't
 * even ship the .wasm binary, so a server binary is the honest
 * durable path).
 *
 * Env:
 *   WORLD_DB_URL   default ws://127.0.0.1:8000/rpc
 *   WORLD_DB_NS    default mmo
 *   WORLD_DB_DB    default world
 *   WORLD_DB_USER / WORLD_DB_PASS  optional credentials
 *
 * SDK result shapes (surrealdb@2 over ws://, verified live):
 *   db.query(sql) -> one entry per statement. Each entry is the
 *   statement's result: an array of rows normally, or the single
 *   unwrapped value for `... ONLY ...` (null when nothing matched).
 */
import { Surreal } from "surrealdb";
import type { MigrationRecord, MigrationState, RegionRecord, StoredDungeonRun, WorldStore } from "./types.js";

export interface SurrealStoreOptions {
  url: string;
  namespace: string;
  database: string;
  username?: string;
  password?: string;
}

const SCHEMA = `
DEFINE TABLE IF NOT EXISTS region SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS regionId ON region TYPE string;
DEFINE FIELD IF NOT EXISTS chunkRange ON region TYPE object;
DEFINE FIELD IF NOT EXISTS chunkRange.x0 ON region TYPE int;
DEFINE FIELD IF NOT EXISTS chunkRange.x1 ON region TYPE int;
DEFINE FIELD IF NOT EXISTS chunkRange.z0 ON region TYPE int;
DEFINE FIELD IF NOT EXISTS chunkRange.z1 ON region TYPE int;
DEFINE FIELD IF NOT EXISTS endpoint ON region TYPE string;
DEFINE FIELD IF NOT EXISTS capacity ON region TYPE int;
DEFINE FIELD IF NOT EXISTS load ON region TYPE float;
DEFINE FIELD IF NOT EXISTS tickJitterMs ON region TYPE float;
DEFINE FIELD IF NOT EXISTS entityCount ON region TYPE int;
DEFINE FIELD IF NOT EXISTS lastTick ON region TYPE int;
DEFINE FIELD IF NOT EXISTS lastHeartbeat ON region TYPE int;
DEFINE FIELD IF NOT EXISTS apiKeyHash ON region TYPE string;
DEFINE FIELD IF NOT EXISTS tokenHash ON region TYPE option<string>;
DEFINE FIELD IF NOT EXISTS tokenIssuedAt ON region TYPE option<int>;
DEFINE TABLE IF NOT EXISTS op_dedup SCHEMALESS;
DEFINE TABLE IF NOT EXISTS meta SCHEMALESS;
DEFINE INDEX IF NOT EXISTS idx_region_regionId ON region FIELDS regionId UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_region_tokenHash ON region FIELDS tokenHash;
-- Slice B. Schemaless: entityState is an arbitrary serialized ECS blob.
DEFINE TABLE IF NOT EXISTS migration SCHEMALESS;
DEFINE INDEX IF NOT EXISTS idx_migration_id ON migration FIELDS migrationId UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_migration_entity ON migration FIELDS entityId, state;
DEFINE INDEX IF NOT EXISTS idx_migration_state ON migration FIELDS state, createdAt;
-- Slice D4: committed dungeon runs, one row per run (idempotent on instance).
DEFINE TABLE IF NOT EXISTS dungeon_run SCHEMALESS;
DEFINE INDEX IF NOT EXISTS idx_dungeon_run_instance ON dungeon_run FIELDS instance UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_dungeon_run_region ON dungeon_run FIELDS regionId;
`;

/** First (only) statement's result. */
function stmt(result: unknown): unknown {
  return Array.isArray(result) ? result[0] : result;
}

/** Unwrap a single-row result (SELECT/CREATE/UPDATE ... ONLY). */
function singleRow<T>(result: unknown): T | null {
  const s = stmt(result);
  if (s == null) return null;
  if (Array.isArray(s)) return (s[0] as T | undefined) ?? null;
  return s as T;
}

/** Unwrap a multi-row result (SELECT, DELETE ... RETURN BEFORE). */
function rowList<T>(result: unknown): T[] {
  const s = stmt(result);
  if (s == null) return [];
  return (Array.isArray(s) ? s : [s]) as T[];
}

function strip(record: Record<string, unknown>): RegionRecord {
  const { id, ...rest } = record;
  return rest as unknown as RegionRecord;
}

function migration(record: Record<string, unknown>): MigrationRecord {
  const { id, ...rest } = record;
  return { ...(rest as unknown as MigrationRecord), entityState: rest["entityState"] ?? null };
}

function dungeonRun(record: Record<string, unknown>): StoredDungeonRun {
  const { id, ...rest } = record;
  return rest as unknown as StoredDungeonRun;
}

export class SurrealWorldStore implements WorldStore {
  private db = new Surreal();
  private readonly opts: SurrealStoreOptions;

  constructor(opts: SurrealStoreOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    await this.db.connect(this.opts.url);
    // Sign in before `use`: on SurrealDB 3.2 selecting a namespace that
    // doesn't exist yet fails unless the session may create it.
    if (this.opts.username) {
      await this.db.signin({
        username: this.opts.username,
        password: this.opts.password ?? "",
      });
    }
    await this.db.use({
      namespace: this.opts.namespace,
      database: this.opts.database,
    });
    await this.db.query(SCHEMA);
    const meta = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY meta WHERE id = meta:registry"),
    );
    if (meta === null) {
      await this.db.query("CREATE meta:registry CONTENT { version: 0 }");
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async upsertRegion(r: RegionRecord): Promise<void> {
    const existing = singleRow(
      await this.db.query("SELECT * FROM ONLY region WHERE regionId = $id", {
        id: r.regionId,
      }),
    );
    const data = {
      regionId: r.regionId,
      chunkRange: r.chunkRange,
      endpoint: r.endpoint,
      capacity: r.capacity,
      load: r.load,
      tickJitterMs: r.tickJitterMs,
      entityCount: r.entityCount,
      lastTick: r.lastTick,
      lastHeartbeat: r.lastHeartbeat,
      apiKeyHash: r.apiKeyHash,
      tokenHash: r.tokenHash,
      tokenIssuedAt: r.tokenIssuedAt,
    };
    if (existing !== null) {
      await this.db.query(
        "UPDATE ONLY region SET chunkRange=$cr, endpoint=$ep, capacity=$cap, load=$load, tickJitterMs=$jit, entityCount=$ec, lastTick=$tick, lastHeartbeat=$hb, apiKeyHash=$akh, tokenHash=$th, tokenIssuedAt=$tia WHERE regionId = $id",
        {
          id: r.regionId,
          cr: r.chunkRange,
          ep: r.endpoint,
          cap: r.capacity,
          load: r.load,
          jit: r.tickJitterMs,
          ec: r.entityCount,
          tick: r.lastTick,
          hb: r.lastHeartbeat,
          akh: r.apiKeyHash,
          th: r.tokenHash,
          tia: r.tokenIssuedAt,
        },
      );
    } else {
      await this.db.query("CREATE ONLY region CONTENT $data", { data });
    }
  }

  async getRegion(regionId: string): Promise<RegionRecord | null> {
    const row = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY region WHERE regionId = $id", {
        id: regionId,
      }),
    );
    return row === null ? null : strip(row);
  }

  async getRegionByTokenHash(tokenHash: string): Promise<RegionRecord | null> {
    const row = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY region WHERE tokenHash = $th", {
        th: tokenHash,
      }),
    );
    return row === null ? null : strip(row);
  }

  async listRegions(): Promise<RegionRecord[]> {
    const rows = rowList<Record<string, unknown>>(
      await this.db.query("SELECT * FROM region"),
    );
    return rows.map(strip);
  }

  async deleteRegion(regionId: string): Promise<void> {
    await this.db.query("DELETE region WHERE regionId = $id", {
      id: regionId,
    });
  }

  async reapStaleRegions(cutoffMs: number): Promise<string[]> {
    const rows = rowList<Record<string, unknown>>(
      await this.db.query(
        "DELETE region WHERE lastHeartbeat < $cutoff RETURN BEFORE",
        { cutoff: cutoffMs },
      ),
    );
    return rows.map((r) => r["regionId"] as string);
  }

  async getOpResult(opId: string): Promise<unknown | null> {
    const row = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY op_dedup WHERE opId = $opId", {
        opId,
      }),
    );
    return row === null ? null : (row["result"] ?? null);
  }

  async storeOpResult(opId: string, result: unknown): Promise<void> {
    await this.db.query(
      "CREATE ONLY op_dedup CONTENT { opId: $opId, result: $result }",
      { opId, result },
    );
  }

  async getRegistryVersion(): Promise<number> {
    const row = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY meta WHERE id = meta:registry"),
    );
    return row === null ? 0 : Number(row["version"] ?? 0);
  }

  async bumpRegistryVersion(): Promise<void> {
    await this.db.query(
      "UPDATE ONLY meta SET version = version + 1 WHERE id = meta:registry",
    );
  }

  // -- migrations (slice B) --

  async createMigration(m: MigrationRecord): Promise<void> {
    await this.db.query("CREATE ONLY migration CONTENT $data", { data: { ...m } });
  }

  async getMigration(migrationId: string): Promise<MigrationRecord | null> {
    const row = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY migration WHERE migrationId = $id LIMIT 1", { id: migrationId }),
    );
    return row === null ? null : migration(row);
  }

  async getBegunMigrationForEntity(entityId: string): Promise<MigrationRecord | null> {
    const row = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY migration WHERE entityId = $e AND state = 'begun' LIMIT 1", { e: entityId }),
    );
    return row === null ? null : migration(row);
  }

  async resolveMigration(migrationId: string, to: Exclude<MigrationState, "begun">, reason: string, now: number): Promise<MigrationRecord | null> {
    // One statement, so the state check and the write are atomic.
    const rows = rowList<Record<string, unknown>>(
      await this.db.query(
        "UPDATE migration SET state = $to, reason = $reason, updatedAt = $now WHERE migrationId = $id AND state = 'begun' RETURN AFTER",
        { id: migrationId, to, reason, now },
      ),
    );
    return rows.length > 0 ? migration(rows[0]) : null;
  }

  async listMigrationsForRegion(regionId: string, sinceMs: number): Promise<MigrationRecord[]> {
    const rows = rowList<Record<string, unknown>>(
      await this.db.query(
        "SELECT * FROM migration WHERE (fromRegion = $r OR toRegion = $r) AND (state = 'begun' OR updatedAt >= $since)",
        { r: regionId, since: sinceMs },
      ),
    );
    return rows.map(migration);
  }

  async listBegunBefore(cutoffMs: number): Promise<string[]> {
    const rows = rowList<Record<string, unknown>>(
      await this.db.query("SELECT migrationId FROM migration WHERE state = 'begun' AND createdAt < $cutoff", { cutoff: cutoffMs }),
    );
    return rows.map((r) => r["migrationId"] as string);
  }

  async pruneMigrations(cutoffMs: number): Promise<number> {
    const rows = rowList<Record<string, unknown>>(
      await this.db.query("DELETE migration WHERE state != 'begun' AND updatedAt < $cutoff RETURN BEFORE", { cutoff: cutoffMs }),
    );
    return rows.length;
  }

  async recordDungeonRun(run: StoredDungeonRun): Promise<boolean> {
    const existing = singleRow(
      await this.db.query("SELECT * FROM ONLY dungeon_run WHERE instance = $id LIMIT 1", { id: run.instance }),
    );
    if (existing !== null) return false;
    await this.db.query("CREATE ONLY dungeon_run CONTENT $data", { data: { ...run } });
    return true;
  }

  async listDungeonRuns(regionId?: string): Promise<StoredDungeonRun[]> {
    const rows =
      regionId === undefined
        ? rowList<Record<string, unknown>>(await this.db.query("SELECT * FROM dungeon_run"))
        : rowList<Record<string, unknown>>(await this.db.query("SELECT * FROM dungeon_run WHERE regionId = $r", { r: regionId }));
    return rows.map(dungeonRun);
  }
}
