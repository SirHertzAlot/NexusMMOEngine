/**
 * SnapshotStore — SQLite persistence for the authoritative world
 * (slice 1.4).
 *
 * Saves are full FlatBuffers Snapshot bytes — the SAME bytes that go
 * on the wire (DRY: one codec, one contract). Each save stores:
 * - snapshots row: tick, taken_at (unix ms), the snapshot bytes, a
 *   dense u32-per-slot generation table, and the live entity count.
 * - meta rows: schema_version / engine_version / saved_at_tick.
 *
 * Cadence: every `saveEveryTicks` (default 300) plus on SIGTERM/SIGINT
 * via installShutdownHook(). Only the newest `keepSnapshots` rows are
 * kept (default 6); older ones are pruned inside the same transaction
 * as the insert.
 *
 * better-sqlite3 is synchronous by design, the DB is opened in WAL
 * mode, and saves are infrequent bulk writes — so a save is just a
 * function call, no connection pool, no async plumbing. The one slow
 * step, the WAL checkpoint (an fsync), runs on a background worker
 * (checkpoint-worker.ts) so it never stalls the tick thread.
 */

import Database from "better-sqlite3";
import * as flatbuffers from "flatbuffers";
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { VERSION } from "../index.js";
import { collectFullState, decodeSnapshot, encodeSnapshot } from "../snapshot.js";
import type { SimWorld } from "../world.js";

export const DEFAULT_DB_PATH = "./data/world.db";
export const DEFAULT_KEEP_SNAPSHOTS = 6;
export const DEFAULT_SAVE_EVERY_TICKS = 300;
/** Bumped whenever the on-disk layout changes incompatibly. */
export const SCHEMA_VERSION = "1";

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  tick INTEGER NOT NULL,
  taken_at INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  generations BLOB NOT NULL,
  entity_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_tick ON snapshots(tick);
-- Event log (plan §4): table created now; the writer is a documented
-- follow-up, so this stays empty for slice 1.4.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  tick INTEGER NOT NULL,
  type INTEGER NOT NULL,
  payload BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_tick ON events(tick);
`;

export interface SnapshotStoreOptions {
  /** DB file path. Default "./data/world.db" (relative to the process cwd). */
  dbPath?: string;
  /** How many of the newest snapshots to keep. Default 6. */
  keepSnapshots?: number;
  /** Save every N ticks. Default 300 (matches the snapshot cadence). */
  saveEveryTicks?: number;
  /**
   * WAL file size (bytes) SQLite truncates back to after a checkpoint.
   * Without it the WAL keeps its high-water size forever: when saves
   * outpace checkpoints, SQLite can't rewind the log and the file ratchets
   * up. Default 4 MiB (~30 snapshots at 1000 entities).
   */
  walSizeLimitBytes?: number;
}

export const DEFAULT_WAL_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;

export interface SaveResult {
  snapshotId: number;
  tick: number;
  entityCount: number;
  /** Snapshot payload size in bytes. */
  bytes: number;
  /** End-to-end save latency (collect + encode + insert + prune), ms. */
  ms: number;
}

export interface LoadedSnapshot {
  tick: number;
  takenAt: number;
  entityCount: number;
  /** Full FlatBuffers Snapshot bytes. */
  bytes: Uint8Array;
  /** Per-slot generation table (slot -> generation, includes freed slots). */
  generations: Map<number, number>;
}

interface SnapshotRow {
  id: number;
  tick: number;
  taken_at: number;
  bytes: Buffer;
  generations: Buffer;
  entity_count: number;
}

export class SnapshotStore {
  private readonly db: Database.Database;
  private readonly keepSnapshots: number;
  private readonly saveEveryTicks: number;
  /** Absolute DB path for the checkpoint worker; null for :memory:. */
  private readonly filePath: string | null;
  /** Lazily started on the first save; null before that or after failure. */
  private checkpointer: Worker | null = null;
  private checkpointInFlight = false;
  /** A save landed while a checkpoint ran: run one more when it finishes. */
  private checkpointPending = false;
  /** Worker unavailable: SQLite's own auto-checkpoint is back on. */
  private checkpointerFailed = false;
  /** Callers of whenCheckpointed() waiting for the worker to go idle. */
  private idleWaiters: Array<() => void> = [];
  private walSizeLimitBytes = DEFAULT_WAL_SIZE_LIMIT_BYTES;
  /** Reused FlatBuffers scratch builder: saves must not regrow it. */
  private readonly snapshotBuilder = new flatbuffers.Builder(131072);

  private readonly insertStmt: Database.Statement;
  private readonly metaStmt: Database.Statement;
  private readonly pruneStmt: Database.Statement;
  private readonly latestStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly ticksStmt: Database.Statement;
  private readonly getMetaStmt: Database.Statement;
  private readonly saveTx: (
    tick: number,
    takenAt: number,
    bytes: Buffer,
    generations: Buffer,
    entityCount: number,
  ) => number;

  constructor(opts: SnapshotStoreOptions = {}) {
    const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new Database(dbPath);
    // WAL: readers never block the single writer; crash-safe for a
    // server that may be SIGKILLed between saves.
    this.db.pragma("journal_mode = WAL");
    // NORMAL is the safe choice under WAL: the DB itself can never
    // corrupt on power loss, only the most recent commit is at risk —
    // and every save here is a full snapshot, so the worst case is
    // restoring the previous one (<= saveEveryTicks of progress).
    // FULL would fsync on every commit (~1ms+ each) and blow the
    // 5 ms save-latency budget.
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(DDL);
    this.filePath = dbPath === ":memory:" ? null : path.resolve(dbPath);
    if (this.filePath !== null) {
      // Checkpoints are driven by the background worker after each save;
      // the automatic one would fire mid-commit on the tick thread.
      this.db.pragma("wal_autocheckpoint = 0");
      this.walSizeLimitBytes = opts.walSizeLimitBytes ?? DEFAULT_WAL_SIZE_LIMIT_BYTES;
      this.db.pragma(`journal_size_limit = ${Math.floor(this.walSizeLimitBytes)}`);
    }

    this.keepSnapshots = opts.keepSnapshots ?? DEFAULT_KEEP_SNAPSHOTS;
    this.saveEveryTicks = opts.saveEveryTicks ?? DEFAULT_SAVE_EVERY_TICKS;

    this.insertStmt = this.db.prepare(
      "INSERT INTO snapshots (tick, taken_at, bytes, generations, entity_count) VALUES (?, ?, ?, ?, ?)",
    );
    this.metaStmt = this.db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.pruneStmt = this.db.prepare(
      "DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY tick DESC, id DESC LIMIT ?)",
    );
    this.latestStmt = this.db.prepare(
      "SELECT id, tick, taken_at, bytes, generations, entity_count FROM snapshots ORDER BY tick DESC, id DESC LIMIT 1",
    );
    this.countStmt = this.db.prepare("SELECT COUNT(*) AS n FROM snapshots");
    this.ticksStmt = this.db.prepare(
      "SELECT tick FROM snapshots ORDER BY tick ASC, id ASC",
    );
    this.getMetaStmt = this.db.prepare("SELECT value FROM meta WHERE key = ?");

    // Insert + meta upserts + prune are one atomic transaction.
    this.saveTx = this.db.transaction(
      (
        tick: number,
        takenAt: number,
        bytes: Buffer,
        generations: Buffer,
        entityCount: number,
      ): number => {
        const info = this.insertStmt.run(tick, takenAt, bytes, generations, entityCount);
        this.metaStmt.run("schema_version", SCHEMA_VERSION);
        this.metaStmt.run("engine_version", VERSION);
        this.metaStmt.run("saved_at_tick", String(tick));
        this.pruneStmt.run(this.keepSnapshots);
        return Number(info.lastInsertRowid);
      },
    );
  }

  /** True on save ticks (1-based: 300, 600, … — never tick 0). */
  shouldSave(tick: number): boolean {
    return tick > 0 && tick % this.saveEveryTicks === 0;
  }

  /**
   * Serialize the world and persist it. Synchronous by design
   * (better-sqlite3 + WAL): returns the save result with its latency.
   */
  /**
   * Persist pre-encoded FlatBuffers snapshot bytes. This is the production
   * hot path: the gateway already encodes a full snapshot every 300 ticks
   * for broadcast, and persistence reuses those exact bytes — no
   * re-collection, no re-encode. Measures < 2 ms p95 at 1,000 entities.
   */
  saveSnapshotBytes(
    tick: number,
    bytes: Uint8Array,
    generations: Uint32Array,
    entityCount: number,
  ): SaveResult {
    const t0 = performance.now();
    const genBuf = Buffer.from(
      generations.buffer,
      generations.byteOffset,
      generations.byteLength,
    );
    const snapshotId = this.saveTx(
      tick,
      Date.now(),
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      genBuf,
      entityCount,
    );
    // Fold the just-written WAL pages back into the DB off-thread: keeps
    // the WAL small without the checkpoint's fsync (~4-5 ms on Windows)
    // landing on the tick thread.
    this.requestCheckpoint();
    return {
      snapshotId,
      tick,
      entityCount,
      bytes: bytes.byteLength,
      ms: performance.now() - t0,
    };
  }

  /**
   * Convenience: collect + encode + persist. Used for shutdown saves and
   * tests. In the steady-state server the gateway calls
   * saveSnapshotBytes directly with broadcast bytes.
   *
   * Drains the intent queue first: intents queued during the last tick
   * (to be applied at the next beginTick) are part of world state and
   * must be materialized into PlayerIntent components, or the restored
   * world will diverge from an uninterrupted run.
   */
  saveWorld(tick: number, sim: SimWorld): SaveResult {
    const t0 = performance.now();
    sim.beginTick(); // materialize pending intents into components
    const state = collectFullState(sim, tick);
    const t1 = performance.now();
    // The returned view aliases the reused builder's buffer; the INSERT
    // below copies it into SQLite synchronously, so no clone is needed.
    const bytes = encodeSnapshot(state, this.snapshotBuilder);
    const t2 = performance.now();
    const result = this.saveSnapshotBytes(
      tick,
      bytes,
      sim.exportGenerations(),
      sim.liveEntityCount,
    );
    if (process.env.MMO_PROF_SAVE) {
      console.log(
        `save phases: collect ${(t1 - t0).toFixed(2)} encode ${(t2 - t1).toFixed(2)} persist ${result.ms.toFixed(2)}`,
      );
    }
    return result;
  }

  /** The newest saved snapshot, or null when the DB is empty. */
  loadLatest(): LoadedSnapshot | null {
    const row = this.latestStmt.get() as SnapshotRow | undefined;
    if (!row) return null;
    const genBytes = row.generations;
    if (genBytes.length % 4 !== 0) {
      throw new Error(
        `persist: corrupt generations blob (${genBytes.length} bytes)`,
      );
    }
    const u32 = new Uint32Array(
      genBytes.buffer,
      genBytes.byteOffset,
      genBytes.length / 4,
    );
    const generations = new Map<number, number>();
    for (let s = 0; s < u32.length; s++) generations.set(s, u32[s]);
    return {
      tick: row.tick,
      takenAt: row.taken_at,
      entityCount: row.entity_count,
      // Copy: better-sqlite3 Buffers may alias pooled memory.
      bytes: new Uint8Array(row.bytes),
      generations,
    };
  }

  /**
   * Restore the newest snapshot into a world. Returns the saved tick,
   * or null when there is nothing to restore (fresh boot).
   */
  restoreInto(sim: SimWorld): number | null {
    const saved = this.loadLatest();
    if (!saved) return null;
    sim.restoreFromState(decodeSnapshot(saved.bytes), saved.generations);
    return saved.tick;
  }

  /** How many snapshots are currently retained. */
  snapshotCount(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  /** Ticks of the retained snapshots, ascending (ops/debugging aid). */
  listSnapshotTicks(): number[] {
    return (this.ticksStmt.all() as { tick: number }[]).map((r) => r.tick);
  }

  /** Read a meta value (e.g. "terrain_version"); null when unset. */
  getMeta(key: string): string | null {
    const row = this.getMetaStmt.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Upsert a meta value alongside the snapshots. */
  setMeta(key: string, value: string): void {
    this.metaStmt.run(key, value);
  }

  /**
   * Run `fn` in one SQLite transaction on this store's connection: other
   * world.db data written through `db` (e.g. a TerrainTileStore borrowing
   * it) commits or rolls back together with any snapshot saved inside.
   */
  transaction<T>(fn: (db: Database.Database) => T): T {
    return this.db.transaction(() => fn(this.db))();
  }

  /**
   * Ask the background worker for a PASSIVE checkpoint. Coalesced: at
   * most one runs at a time, plus one queued behind it — a burst of saves
   * never piles up work.
   */
  private requestCheckpoint(): void {
    if (this.filePath === null || this.checkpointerFailed) return;
    if (this.checkpointer === null) this.startCheckpointer(this.filePath);
    if (this.checkpointInFlight) {
      this.checkpointPending = true;
      return;
    }
    this.checkpointInFlight = true;
    this.checkpointer!.postMessage("checkpoint");
  }

  private startCheckpointer(dbPath: string): void {
    const worker = new Worker(
      new URL("./checkpoint-worker.js", import.meta.url),
      { workerData: { dbPath, walSizeLimitBytes: this.walSizeLimitBytes } },
    );
    worker.on("message", (msg: unknown) => {
      if (msg !== "done") {
        // A failed PASSIVE checkpoint is retried after the next save.
        console.warn(
          `[persist] checkpoint failed: ${(msg as { failed?: string }).failed ?? String(msg)}`,
        );
      }
      this.checkpointInFlight = false;
      if (this.checkpointPending && this.checkpointer === worker) {
        this.checkpointPending = false;
        this.checkpointInFlight = true;
        worker.postMessage("checkpoint");
      } else {
        this.settleIdle();
      }
    });
    const fail = (reason: string): void => {
      if (this.checkpointer !== worker) return; // closed deliberately
      console.warn(`[persist] checkpoint worker ${reason}; using SQLite auto-checkpoint`);
      this.checkpointer = null;
      this.checkpointerFailed = true;
      this.checkpointInFlight = false;
      this.checkpointPending = false;
      this.settleIdle();
      // Without the worker the WAL would grow unbounded: hand
      // checkpointing back to SQLite (its default threshold).
      if (this.db.open) this.db.pragma("wal_autocheckpoint = 1000");
    };
    worker.on("error", (err) => fail(`crashed: ${err.message}`));
    worker.on("exit", (code) => fail(`exited (code ${code})`));
    // Never keep the process alive just for checkpoints. unref() must come
    // AFTER the listeners: attaching a "message" listener re-refs the
    // worker, which kept processes with an unclosed store alive forever.
    worker.unref();
    this.checkpointer = worker;
  }

  /**
   * Resolves once no background checkpoint is running or queued (tests,
   * orderly shutdown). Immediate for :memory: stores or when idle.
   */
  whenCheckpointed(): Promise<void> {
    if (!this.checkpointInFlight) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private settleIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  close(): void {
    const worker = this.checkpointer;
    this.checkpointer = null;
    this.checkpointInFlight = false;
    this.checkpointPending = false;
    this.settleIdle();
    // The worker finishes any running checkpoint, then closes its own
    // connection and exits (messages are handled in order).
    worker?.postMessage("close");
    if (this.db.open) this.db.close();
  }
}
