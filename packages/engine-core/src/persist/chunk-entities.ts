/**
 * ChunkEntityStore — what each UNLOADED chunk holds (trees, rocks, …), in
 * world.db beside the snapshots and terrain tiles.
 *
 * With streaming (see streaming/chunk-streamer.ts) the live world holds
 * only chunks near players. When a chunk unloads, its entities are encoded
 * into one row here — the same FlatBuffers snapshot format as whole-world
 * saves — and despawned; when it loads again they are spawned back from
 * the row. A chunk with no row has never been unloaded: it is populated
 * fresh (scatter) on load.
 *
 * Authority: while a chunk is loaded, the live world (and its periodic
 * snapshot) is the truth and the chunk's row may be stale; the row is
 * rewritten when the chunk unloads. After a restart, a chunk whose chunk
 * entity is in the restored snapshot is loaded (its row is ignored);
 * every other chunk comes from its row, or fresh.
 */

import Database from "better-sqlite3";

const DDL = `
CREATE TABLE IF NOT EXISTS chunk_entities (
  cx INTEGER NOT NULL,
  cz INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (cx, cz)
);
`;

export interface ChunkEntitiesRow {
  cx: number;
  cz: number;
  /** Server tick the chunk unloaded at. */
  tick: number;
  /** FlatBuffers Snapshot of the chunk's entities. */
  bytes: Uint8Array;
}

export class ChunkEntityStore {
  private readonly db: Database.Database;
  /** False when borrowing another store's connection (don't close it). */
  private readonly ownsDb: boolean;
  private readonly getStmt: Database.Statement;
  private readonly putStmt: Database.Statement;
  private readonly rangeStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly putManyTx: (rows: readonly ChunkEntitiesRow[]) => void;

  /**
   * Open world.db by path, or borrow an open connection (one transaction
   * with a snapshot). `autoCheckpoint: false` leaves WAL checkpoints to
   * another connection — the server's SnapshotStore runs them on a worker
   * after every save — so writes here never pay a checkpoint's fsync.
   */
  constructor(db: string | Database.Database, opts: { autoCheckpoint?: boolean } = {}) {
    this.ownsDb = typeof db === "string";
    if (typeof db === "string") {
      this.db = new Database(db);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      if (opts.autoCheckpoint === false) this.db.pragma("wal_autocheckpoint = 0");
    } else {
      this.db = db;
    }
    this.db.exec(DDL);
    this.getStmt = this.db.prepare("SELECT cx, cz, tick, bytes FROM chunk_entities WHERE cx = ? AND cz = ?");
    this.putStmt = this.db.prepare(
      "INSERT INTO chunk_entities (cx, cz, tick, bytes) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(cx, cz) DO UPDATE SET tick = excluded.tick, bytes = excluded.bytes",
    );
    this.rangeStmt = this.db.prepare(
      "SELECT cx, cz, tick, bytes FROM chunk_entities WHERE cx BETWEEN ? AND ? AND cz BETWEEN ? AND ? ORDER BY cz, cx",
    );
    this.countStmt = this.db.prepare("SELECT COUNT(*) AS n FROM chunk_entities");
    this.putManyTx = this.db.transaction((rows: readonly ChunkEntitiesRow[]) => {
      for (const r of rows) {
        this.putStmt.run(r.cx, r.cz, r.tick, Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength));
      }
    });
  }

  /** A chunk's stored entities, or null when it has never been unloaded. */
  get(cx: number, cz: number): ChunkEntitiesRow | null {
    const row = this.getStmt.get(cx, cz) as { cx: number; cz: number; tick: number; bytes: Buffer } | undefined;
    return row ? { ...row, bytes: new Uint8Array(row.bytes) } : null;
  }

  /** Insert or replace rows atomically (one unload pass = one transaction). */
  putMany(rows: readonly ChunkEntitiesRow[]): void {
    if (rows.length > 0) this.putManyTx(rows);
  }

  /** Rows with cx0 <= cx <= cx1 and cz0 <= cz <= cz1. */
  getRange(cx0: number, cz0: number, cx1: number, cz1: number): ChunkEntitiesRow[] {
    return (this.rangeStmt.all(cx0, cx1, cz0, cz1) as Array<{ cx: number; cz: number; tick: number; bytes: Buffer }>).map(
      (r) => ({ ...r, bytes: new Uint8Array(r.bytes) }),
    );
  }

  count(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  close(): void {
    if (this.ownsDb && this.db.open) this.db.close();
  }
}
