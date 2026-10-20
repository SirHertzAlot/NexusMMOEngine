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
import {
  applyAuctionSettle,
  applyCraftExecute,
  applyInventoryMutate,
  applyLootGrant,
  applyTradeCommit,
  applyVendorTransact,
  type AtomicContext,
  type AtomicOutcome,
} from "./atomic.js";
import type {
  AtomicLedgerEntry,
  AtomicOpKind,
  AtomicOpResult,
  AuctionSettleInput,
  CharacterSessionLock,
  CharacterStateRecord,
  CraftExecuteInput,
  HostResourceReport,
  InventoryMutateInput,
  LedgerEvent,
  LootGrantInput,
  MigrationRecord,
  MigrationState,
  RegionRecord,
  ShardSnapshotRecord,
  StoredDungeonRun,
  StoredLedgerEvent,
  TradeCommitInput,
  VendorTransactInput,
  WorldStore,
} from "./types.js";

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
DEFINE FIELD IF NOT EXISTS epoch ON region TYPE int;
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
-- Slice S2: online character names per region (replaced on every report).
DEFINE TABLE IF NOT EXISTS presence SCHEMALESS;
DEFINE INDEX IF NOT EXISTS idx_presence_region ON presence FIELDS regionId UNIQUE;
-- Persistence P1: the state plane. Schemaless: payloads/state are opaque.
-- Epoch counters (key: "range:<rangeKey>" | "character:<characterId>").
DEFINE TABLE IF NOT EXISTS epoch_counter SCHEMALESS;
DEFINE INDEX IF NOT EXISTS idx_epoch_counter_key ON epoch_counter FIELDS key UNIQUE;
DEFINE TABLE IF NOT EXISTS shard_snapshot SCHEMALESS;
DEFINE INDEX IF NOT EXISTS idx_shard_snapshot_range ON shard_snapshot FIELDS rangeKey UNIQUE;
DEFINE TABLE IF NOT EXISTS ledger_event SCHEMALESS;
DEFINE INDEX IF NOT EXISTS idx_ledger_event_range_seq ON ledger_event FIELDS rangeKey, seq UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_ledger_event_range ON ledger_event FIELDS rangeKey;
DEFINE TABLE IF NOT EXISTS character_state SCHEMALESS;
DEFINE INDEX IF NOT EXISTS idx_character_state_id ON character_state FIELDS characterId UNIQUE;
DEFINE TABLE IF NOT EXISTS character_lock SCHEMALESS;
DEFINE INDEX IF NOT EXISTS idx_character_lock_id ON character_lock FIELDS characterId UNIQUE;
-- Persistence P5: host resource reports (sidecar upserts, TTL'd).
DEFINE TABLE IF NOT EXISTS host_report SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS hostId ON host_report TYPE string;
DEFINE FIELD IF NOT EXISTS cpuCores ON host_report TYPE int;
DEFINE FIELD IF NOT EXISTS ramTotalBytes ON host_report TYPE int;
DEFINE FIELD IF NOT EXISTS ramFreeBytes ON host_report TYPE int;
DEFINE FIELD IF NOT EXISTS shardLoad ON host_report TYPE option<float>;
DEFINE FIELD IF NOT EXISTS reportedAt ON host_report TYPE int;
DEFINE INDEX IF NOT EXISTS idx_host_report_id ON host_report FIELDS hostId UNIQUE;
-- Atomic operations (A1): the world item ledger the six value-moving
-- operations append to inside the same transaction as the state
-- change, plus its seq counter (single row, atomic_meta:ledger).
DEFINE TABLE IF NOT EXISTS atomic_ledger SCHEMALESS;
DEFINE INDEX IF NOT EXISTS idx_atomic_ledger_seq ON atomic_ledger FIELDS seq UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_atomic_ledger_op ON atomic_ledger FIELDS opId;
DEFINE TABLE IF NOT EXISTS atomic_meta SCHEMALESS;
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

function stripId<T>(record: Record<string, unknown>): T {
  const { id, ...rest } = record;
  return rest as T;
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
    const atomicMeta = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY atomic_meta WHERE id = atomic_meta:ledger"),
    );
    if (atomicMeta === null) {
      await this.db.query("CREATE atomic_meta:ledger CONTENT { seq: 0 }");
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
      epoch: r.epoch,
      apiKeyHash: r.apiKeyHash,
      tokenHash: r.tokenHash,
      tokenIssuedAt: r.tokenIssuedAt,
    };
    if (existing !== null) {
      await this.db.query(
        "UPDATE ONLY region SET chunkRange=$cr, endpoint=$ep, capacity=$cap, load=$load, tickJitterMs=$jit, entityCount=$ec, lastTick=$tick, lastHeartbeat=$hb, epoch=$epoch, apiKeyHash=$akh, tokenHash=$th, tokenIssuedAt=$tia WHERE regionId = $id",
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
          epoch: r.epoch,
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

  async setPresence(regionId: string, names: string[]): Promise<void> {
    await this.db.query("DELETE presence WHERE regionId = $r", { r: regionId });
    if (names.length > 0) {
      await this.db.query("CREATE ONLY presence CONTENT $data", { data: { regionId, names } });
    }
  }

  async queryPresence(names: string[]): Promise<Map<string, string | null>> {
    const rows = rowList<Record<string, unknown>>(await this.db.query("SELECT regionId, names FROM presence"));
    const found = new Map<string, string>();
    for (const row of rows) {
      const regionId = row["regionId"] as string;
      for (const n of (row["names"] as string[]).filter((x) => names.includes(x))) {
        if (!found.has(n)) found.set(n, regionId);
      }
    }
    return new Map(names.map((n) => [n, found.get(n) ?? null]));
  }

  // -- state plane (persistence P1) --

  /** Shared counter behind both epoch kinds, following the check-then-write pattern of recordDungeonRun. */
  private async issueEpoch(key: string): Promise<number> {
    const row = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY epoch_counter WHERE key = $key", { key }),
    );
    const next = (row === null ? 0 : Number(row["value"] ?? 0)) + 1;
    if (row === null) {
      await this.db.query("CREATE ONLY epoch_counter CONTENT { key: $key, value: $value }", { key, value: next });
    } else {
      await this.db.query("UPDATE ONLY epoch_counter SET value = $value WHERE key = $key", { key, value: next });
    }
    return next;
  }

  private async currentEpoch(key: string): Promise<number> {
    const row = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY epoch_counter WHERE key = $key", { key }),
    );
    return row === null ? 0 : Number(row["value"] ?? 0);
  }

  async issueRangeEpoch(rangeKey: string): Promise<number> {
    return this.issueEpoch(`range:${rangeKey}`);
  }

  async getRangeEpoch(rangeKey: string): Promise<number> {
    return this.currentEpoch(`range:${rangeKey}`);
  }

  async issueCharacterLockEpoch(characterId: number): Promise<number> {
    return this.issueEpoch(`character:${characterId}`);
  }

  async putShardSnapshot(s: ShardSnapshotRecord): Promise<void> {
    const existing = singleRow(
      await this.db.query("SELECT * FROM ONLY shard_snapshot WHERE rangeKey = $rk LIMIT 1", { rk: s.rangeKey }),
    );
    if (existing !== null) {
      await this.db.query(
        "UPDATE ONLY shard_snapshot SET regionId=$region, tick=$tick, epoch=$epoch, digest=$digest, payload=$payload, storedAt=$storedAt WHERE rangeKey = $rk",
        { rk: s.rangeKey, region: s.regionId, tick: s.tick, epoch: s.epoch, digest: s.digest, payload: s.payload, storedAt: s.storedAt },
      );
    } else {
      await this.db.query("CREATE ONLY shard_snapshot CONTENT $data", { data: { ...s } });
    }
  }

  async getLatestShardSnapshot(rangeKey: string): Promise<ShardSnapshotRecord | null> {
    const row = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY shard_snapshot WHERE rangeKey = $rk LIMIT 1", { rk: rangeKey }),
    );
    return row === null ? null : stripId<ShardSnapshotRecord>(row);
  }

  async appendLedgerEvents(rangeKey: string, events: LedgerEvent[]): Promise<number> {
    for (const e of events) {
      // Idempotent on (rangeKey, seq): the first-written event wins.
      const existing = singleRow(
        await this.db.query("SELECT * FROM ONLY ledger_event WHERE rangeKey = $rk AND seq = $seq LIMIT 1", { rk: rangeKey, seq: e.seq }),
      );
      if (existing === null) {
        await this.db.query("CREATE ONLY ledger_event CONTENT $data", { data: { ...e, rangeKey } });
      }
    }
    return this.getLedgerHead(rangeKey);
  }

  async getLedgerEvents(rangeKey: string, afterSeq: number): Promise<StoredLedgerEvent[]> {
    const rows = rowList<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ledger_event WHERE rangeKey = $rk AND seq > $after ORDER BY seq ASC", { rk: rangeKey, after: afterSeq }),
    );
    return rows.map((r) => stripId<StoredLedgerEvent>(r));
  }

  async getLedgerHead(rangeKey: string): Promise<number> {
    const rows = rowList<Record<string, unknown>>(
      await this.db.query("SELECT seq FROM ledger_event WHERE rangeKey = $rk ORDER BY seq ASC", { rk: rangeKey }),
    );
    let head = 0;
    for (const r of rows) {
      if (Number(r["seq"]) !== head + 1) break;
      head += 1;
    }
    return head;
  }

  async getCharacterState(characterId: number): Promise<CharacterStateRecord | null> {
    const row = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY character_state WHERE characterId = $id LIMIT 1", { id: characterId }),
    );
    return row === null ? null : stripId<CharacterStateRecord>(row);
  }

  async putCharacterState(r: CharacterStateRecord): Promise<void> {
    const existing = singleRow(
      await this.db.query("SELECT * FROM ONLY character_state WHERE characterId = $id LIMIT 1", { id: r.characterId }),
    );
    if (existing !== null) {
      await this.db.query(
        "UPDATE ONLY character_state SET state=$state, version=$version, epoch=$epoch, regionId=$region, updatedAt=$updatedAt WHERE characterId = $id",
        { id: r.characterId, state: r.state, version: r.version, epoch: r.epoch, region: r.regionId, updatedAt: r.updatedAt },
      );
    } else {
      await this.db.query("CREATE ONLY character_state CONTENT $data", { data: { ...r } });
    }
  }

  async getCharacterLock(characterId: number): Promise<CharacterSessionLock | null> {
    const row = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY character_lock WHERE characterId = $id LIMIT 1", { id: characterId }),
    );
    return row === null ? null : stripId<CharacterSessionLock>(row);
  }

  async putCharacterLock(l: CharacterSessionLock): Promise<void> {
    const existing = singleRow(
      await this.db.query("SELECT * FROM ONLY character_lock WHERE characterId = $id LIMIT 1", { id: l.characterId }),
    );
    if (existing !== null) {
      await this.db.query(
        "UPDATE ONLY character_lock SET regionId=$region, epoch=$epoch, expiresAt=$expiresAt WHERE characterId = $id",
        { id: l.characterId, region: l.regionId, epoch: l.epoch, expiresAt: l.expiresAt },
      );
    } else {
      await this.db.query("CREATE ONLY character_lock CONTENT $data", { data: { ...l } });
    }
  }

  async deleteCharacterLock(characterId: number): Promise<void> {
    await this.db.query("DELETE character_lock WHERE characterId = $id", { id: characterId });
  }

  // -- atomic operations (slice A1) --
  //
  // Semantics come from src/atomic.ts, shared with the fake store:
  // the records and locks are read in ONE query, the pure transition
  // validates everything and computes the commit, and the commit —
  // character records plus item-ledger entries — is persisted in ONE
  // transaction. Every record write is version-guarded
  // (WHERE version = <the version the transition read>) and the
  // ledger seq counter is guarded the same way; a guard tripping
  // THROWs inside the transaction, SurrealDB cancels it, and nothing
  // commits — the caller sees a VERSION_CONFLICT rejection instead.
  // A business rejection never opens a transaction at all.

  /** One statement's single-row value from a multi-statement query result. */
  private static rowValue(v: unknown): Record<string, unknown> | null {
    if (v == null) return null;
    if (Array.isArray(v)) return (v[0] as Record<string, unknown> | undefined) ?? null;
    return v as Record<string, unknown>;
  }

  private async runAtomic(
    op: AtomicOpKind,
    opId: string,
    regionId: string,
    participantIds: number[],
    apply: (ctx: AtomicContext) => AtomicOutcome,
  ): Promise<AtomicOpResult> {
    const readStmts: string[] = [];
    const readParams: Record<string, unknown> = {};
    participantIds.forEach((id, i) => {
      readParams[`c${i}`] = id;
      readStmts.push(`SELECT * FROM ONLY character_state WHERE characterId = $c${i} LIMIT 1`);
      readStmts.push(`SELECT * FROM ONLY character_lock WHERE characterId = $c${i} LIMIT 1`);
    });
    readStmts.push("SELECT seq FROM ONLY atomic_meta WHERE id = atomic_meta:ledger");
    const results = (await this.db.query(readStmts.join(";\n"), readParams)) as unknown[];

    const records = new Map<number, CharacterStateRecord | null>();
    const locks = new Map<number, CharacterSessionLock | null>();
    participantIds.forEach((id, i) => {
      const recRow = SurrealWorldStore.rowValue(results[2 * i]);
      const lockRow = SurrealWorldStore.rowValue(results[2 * i + 1]);
      records.set(id, recRow === null ? null : stripId<CharacterStateRecord>(recRow));
      locks.set(id, lockRow === null ? null : stripId<CharacterSessionLock>(lockRow));
    });
    const counterRow = SurrealWorldStore.rowValue(results[results.length - 1]);
    const baseSeq = counterRow === null ? 0 : Number(counterRow["seq"] ?? 0);

    const now = Date.now();
    const outcome = apply({ regionId, now, records, locks });
    if (!outcome.ok) {
      return { ok: false, opId, op, rejection: outcome.rejection, message: outcome.message };
    }

    const entries: AtomicLedgerEntry[] = outcome.commit.ledger.map((d, j) => ({
      ...d,
      seq: baseSeq + j + 1,
      at: now,
    }));
    const txParams: Record<string, unknown> = {
      baseSeq,
      newSeq: baseSeq + entries.length,
    };
    const tx: string[] = ["BEGIN TRANSACTION"];
    // The seq counter is the transaction's optimistic lock: if a
    // concurrent operation committed first, this aborts untouched.
    tx.push("LET $ctr = (SELECT seq FROM ONLY atomic_meta WHERE id = atomic_meta:ledger)");
    tx.push('IF $ctr = NONE OR $ctr.seq != $baseSeq { THROW "VERSION_CONFLICT" }');
    tx.push("UPDATE ONLY atomic_meta SET seq = $newSeq WHERE id = atomic_meta:ledger");
    outcome.commit.records.forEach((r, i) => {
      txParams[`cid${i}`] = r.characterId;
      txParams[`st${i}`] = r.state;
      txParams[`ver${i}`] = r.version;
      txParams[`ep${i}`] = r.epoch;
      txParams[`rg${i}`] = r.regionId;
      txParams[`up${i}`] = r.updatedAt;
      txParams[`ev${i}`] = r.version - 1;
      if ((records.get(r.characterId) ?? null) !== null) {
        tx.push(
          `LET $u${i} = (UPDATE ONLY character_state SET state = $st${i}, version = $ver${i}, epoch = $ep${i}, regionId = $rg${i}, updatedAt = $up${i} WHERE characterId = $cid${i} AND version = $ev${i} RETURN AFTER)`,
        );
        tx.push(`IF $u${i} = NONE { THROW "VERSION_CONFLICT" }`);
      } else {
        // The characterId unique index makes a raced create fail the
        // whole transaction rather than overwrite a fresher record.
        tx.push(
          `CREATE ONLY character_state CONTENT { characterId: $cid${i}, state: $st${i}, version: $ver${i}, epoch: $ep${i}, regionId: $rg${i}, updatedAt: $up${i} }`,
        );
      }
    });
    entries.forEach((e, j) => {
      txParams[`led${j}`] = { ...e };
      tx.push(`CREATE ONLY atomic_ledger CONTENT $led${j}`);
    });
    tx.push("COMMIT TRANSACTION");
    try {
      await this.db.query(tx.join(";\n"), txParams);
    } catch (err) {
      // A guard tripped or an index raced: the transaction was
      // cancelled and nothing committed.
      return {
        ok: false,
        opId,
        op,
        rejection: "VERSION_CONFLICT",
        message: `atomic commit aborted, nothing applied: ${(err as Error).message}`,
      };
    }
    return { ok: true, opId, op, characters: outcome.commit.records, ledger: entries };
  }

  async tradeCommit(input: TradeCommitInput): Promise<AtomicOpResult> {
    return this.runAtomic("tradeCommit", input.opId, input.regionId, [input.a.characterId, input.b.characterId], (ctx) =>
      applyTradeCommit(ctx, input),
    );
  }

  async vendorTransact(input: VendorTransactInput): Promise<AtomicOpResult> {
    return this.runAtomic("vendorTransact", input.opId, input.regionId, [input.participant.characterId], (ctx) =>
      applyVendorTransact(ctx, input),
    );
  }

  async auctionSettle(input: AuctionSettleInput): Promise<AtomicOpResult> {
    return this.runAtomic(
      "auctionSettle",
      input.opId,
      input.regionId,
      [input.buyer.characterId, input.seller.characterId],
      (ctx) => applyAuctionSettle(ctx, input),
    );
  }

  async craftExecute(input: CraftExecuteInput): Promise<AtomicOpResult> {
    return this.runAtomic("craftExecute", input.opId, input.regionId, [input.participant.characterId], (ctx) =>
      applyCraftExecute(ctx, input),
    );
  }

  async lootGrant(input: LootGrantInput): Promise<AtomicOpResult> {
    return this.runAtomic("lootGrant", input.opId, input.regionId, [input.participant.characterId], (ctx) =>
      applyLootGrant(ctx, input),
    );
  }

  async inventoryMutate(input: InventoryMutateInput): Promise<AtomicOpResult> {
    return this.runAtomic("inventoryMutate", input.opId, input.regionId, [input.participant.characterId], (ctx) =>
      applyInventoryMutate(ctx, input),
    );
  }

  async getAtomicLedger(): Promise<AtomicLedgerEntry[]> {
    const rows = rowList<Record<string, unknown>>(
      await this.db.query("SELECT * FROM atomic_ledger ORDER BY seq ASC"),
    );
    return rows.map((r) => stripId<AtomicLedgerEntry>(r));
  }

  // -- host reports (persistence P5) --

  async upsertHostReport(r: HostResourceReport): Promise<void> {
    const existing = singleRow(
      await this.db.query("SELECT * FROM ONLY host_report WHERE hostId = $id LIMIT 1", { id: r.hostId }),
    );
    const data = {
      hostId: r.hostId,
      cpuCores: r.cpuCores,
      ramTotalBytes: r.ramTotalBytes,
      ramFreeBytes: r.ramFreeBytes,
      shardLoad: r.shardLoad ?? null,
      reportedAt: r.reportedAt,
    };
    if (existing !== null) {
      await this.db.query(
        "UPDATE ONLY host_report SET cpuCores=$cores, ramTotalBytes=$total, ramFreeBytes=$free, shardLoad=$load, reportedAt=$at WHERE hostId = $id",
        { id: r.hostId, cores: r.cpuCores, total: r.ramTotalBytes, free: r.ramFreeBytes, load: data.shardLoad, at: r.reportedAt },
      );
    } else {
      await this.db.query("CREATE ONLY host_report CONTENT $data", { data });
    }
  }

  async getHostReport(hostId: string): Promise<HostResourceReport | null> {
    const row = singleRow<Record<string, unknown>>(
      await this.db.query("SELECT * FROM ONLY host_report WHERE hostId = $id LIMIT 1", { id: hostId }),
    );
    if (row === null) return null;
    const r = stripId<HostResourceReport>(row);
    // SCHEMAFULL stores an absent shardLoad as null; the domain type omits it.
    if (r.shardLoad === null) delete r.shardLoad;
    return r;
  }

  async listHostReports(): Promise<HostResourceReport[]> {
    const rows = rowList<Record<string, unknown>>(
      await this.db.query("SELECT * FROM host_report"),
    );
    return rows.map((row) => {
      const r = stripId<HostResourceReport>(row);
      if (r.shardLoad === null) delete r.shardLoad;
      return r;
    });
  }

  async reapStaleHostReports(cutoffMs: number): Promise<string[]> {
    const rows = rowList<Record<string, unknown>>(
      await this.db.query(
        "DELETE host_report WHERE reportedAt < $cutoff RETURN BEFORE",
        { cutoff: cutoffMs },
      ),
    );
    return rows.map((r) => r["hostId"] as string);
  }
}
