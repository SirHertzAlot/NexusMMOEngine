/**
 * TerrainTileStore — the world heightmap's chunk tiles, stored in world.db.
 *
 * Terrain is generated once (bake or fresh boot) and from then on it is
 * data: the server reads these tiles instead of re-running noise, and the
 * editor sculpts them. Each row is one chunk's 16x16 heights as 256
 * little-endian float32s (1 KiB); neighbouring tiles share their border
 * samples (see @mmo-engine/protocol terrain-grid).
 *
 * Lives in world.db beside the snapshots, so a world's terrain and the
 * entities placed on it are baked, backed up, and replaced together.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { TILE_SAMPLES, type TerrainTile } from "@mmo-engine/protocol";

const SAMPLES = TILE_SAMPLES * TILE_SAMPLES;

/** Written into the data dir by a running server (its pid). */
export const SERVER_PID_FILE = "server.pid";

/**
 * Pid of a live server owning this data dir, or null. A leftover file from
 * a crashed server (pid no longer alive) doesn't count.
 */
export function runningServerPid(dataDir: string): number | null {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(path.join(dataDir, SERVER_PID_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    process.kill(pid, 0); // existence probe, no signal sent
    return pid;
  } catch (err) {
    // EPERM: alive but owned by another user — still running.
    return (err as { code?: string }).code === "EPERM" ? pid : null;
  }
}

const DDL = `
CREATE TABLE IF NOT EXISTS terrain_tiles (
  cx INTEGER NOT NULL,
  cz INTEGER NOT NULL,
  heights BLOB NOT NULL,
  PRIMARY KEY (cx, cz)
);
CREATE TABLE IF NOT EXISTS world_maps (
  name TEXT PRIMARY KEY,
  width INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  cell REAL NOT NULL,
  origin_x REAL NOT NULL,
  origin_z REAL NOT NULL,
  dtype TEXT NOT NULL,
  data BLOB NOT NULL
);
`;

function toBlob(heights: Float32Array): Buffer {
  if (heights.length !== SAMPLES) {
    throw new Error(`terrain-tiles: want ${SAMPLES} heights, got ${heights.length}`);
  }
  return Buffer.from(heights.buffer, heights.byteOffset, heights.byteLength);
}

/** Copy (not view): SQLite blobs aren't guaranteed 4-byte aligned. */
function fromBlob(blob: Buffer): Float32Array {
  const out = new Float32Array(SAMPLES);
  new Uint8Array(out.buffer).set(blob.subarray(0, out.byteLength));
  return out;
}

/**
 * A whole-world survey map (coarse grid): cell (u, v) at world
 * (originX + u*cell, originZ + v*cell), row-major.
 */
export interface WorldMap {
  width: number;
  depth: number;
  cell: number;
  originX: number;
  originZ: number;
  data: Float32Array | Uint8Array | Uint16Array;
}

const DTYPES = {
  f32: Float32Array,
  u8: Uint8Array,
  u16: Uint16Array,
} as const;

function dtypeOf(data: WorldMap["data"]): keyof typeof DTYPES {
  if (data instanceof Float32Array) return "f32";
  if (data instanceof Uint16Array) return "u16";
  return "u8";
}

/**
 * Older world.db files stored tiles in a WITHOUT ROWID table. Those keep
 * rows in the primary-key b-tree, and a 1 KiB row is past its inline limit,
 * so every tile spilled into overflow pages (a 4 km world took ~4x the
 * space). Rebuild such a table as an ordinary rowid table, in place.
 */
function migrateRowidTiles(db: Database.Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'terrain_tiles'").get() as
    | { sql: string }
    | undefined;
  if (!row || !/WITHOUT\s+ROWID/i.test(row.sql)) return;
  db.transaction(() => {
    db.exec(
      "CREATE TABLE terrain_tiles_rowid (cx INTEGER NOT NULL, cz INTEGER NOT NULL, heights BLOB NOT NULL, PRIMARY KEY (cx, cz));" +
        "INSERT INTO terrain_tiles_rowid (cx, cz, heights) SELECT cx, cz, heights FROM terrain_tiles;" +
        "DROP TABLE terrain_tiles;" +
        "ALTER TABLE terrain_tiles_rowid RENAME TO terrain_tiles;",
    );
  })();
}

export class TerrainTileStore {
  private readonly db: Database.Database;
  /** False when borrowing another store's connection (don't close it). */
  private readonly ownsDb: boolean;
  private readonly getStmt: Database.Statement;
  private readonly putStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly rangeStmt: Database.Statement;
  private readonly putMapStmt: Database.Statement;
  private readonly getMapStmt: Database.Statement;
  private readonly putManyTx: (tiles: readonly TerrainTile[]) => void;

  /**
   * Open world.db by path, or borrow an open connection (e.g. inside
   * SnapshotStore.transaction, so tiles and a snapshot commit atomically).
   */
  constructor(db: string | Database.Database) {
    this.ownsDb = typeof db === "string";
    if (typeof db === "string") {
      this.db = new Database(db);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
    } else {
      this.db = db;
    }
    migrateRowidTiles(this.db);
    this.db.exec(DDL);
    this.getStmt = this.db.prepare("SELECT heights FROM terrain_tiles WHERE cx = ? AND cz = ?");
    this.putStmt = this.db.prepare(
      "INSERT INTO terrain_tiles (cx, cz, heights) VALUES (?, ?, ?) " +
        "ON CONFLICT(cx, cz) DO UPDATE SET heights = excluded.heights",
    );
    this.listStmt = this.db.prepare("SELECT cx, cz, heights FROM terrain_tiles ORDER BY cz, cx");
    this.countStmt = this.db.prepare("SELECT COUNT(*) AS n FROM terrain_tiles");
    this.rangeStmt = this.db.prepare(
      "SELECT cx, cz, heights FROM terrain_tiles WHERE cx BETWEEN ? AND ? AND cz BETWEEN ? AND ? ORDER BY cz, cx",
    );
    this.putMapStmt = this.db.prepare(
      "INSERT INTO world_maps (name, width, depth, cell, origin_x, origin_z, dtype, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(name) DO UPDATE SET width = excluded.width, depth = excluded.depth, cell = excluded.cell, " +
        "origin_x = excluded.origin_x, origin_z = excluded.origin_z, dtype = excluded.dtype, data = excluded.data",
    );
    this.getMapStmt = this.db.prepare("SELECT * FROM world_maps WHERE name = ?");
    this.putManyTx = this.db.transaction((tiles: readonly TerrainTile[]) => {
      for (const t of tiles) this.putStmt.run(t.cx, t.cz, toBlob(t.heights));
    });
  }

  /** One chunk's heights, or null when the chunk has no stored tile. */
  get(cx: number, cz: number): Float32Array | null {
    const row = this.getStmt.get(cx, cz) as { heights: Buffer } | undefined;
    return row ? fromBlob(row.heights) : null;
  }

  /** Insert or replace tiles atomically (all or nothing). */
  putMany(tiles: readonly TerrainTile[]): void {
    this.putManyTx(tiles);
  }

  list(): TerrainTile[] {
    return (this.listStmt.all() as Array<{ cx: number; cz: number; heights: Buffer }>).map(
      (r) => ({ cx: r.cx, cz: r.cz, heights: fromBlob(r.heights) }),
    );
  }

  /** Stored tiles with cx0 <= cx <= cx1 and cz0 <= cz <= cz1 — an area, never the whole world. */
  getRange(cx0: number, cz0: number, cx1: number, cz1: number): TerrainTile[] {
    return (this.rangeStmt.all(cx0, cx1, cz0, cz1) as Array<{ cx: number; cz: number; heights: Buffer }>).map(
      (r) => ({ cx: r.cx, cz: r.cz, heights: fromBlob(r.heights) }),
    );
  }

  /** Store a survey map (elevation, biome, rivers, …) under a name. */
  putMap(name: string, map: WorldMap): void {
    const d = map.data;
    this.putMapStmt.run(
      name, map.width, map.depth, map.cell, map.originX, map.originZ, dtypeOf(d),
      Buffer.from(d.buffer, d.byteOffset, d.byteLength),
    );
  }

  getMap(name: string): WorldMap | null {
    const row = this.getMapStmt.get(name) as
      | { width: number; depth: number; cell: number; origin_x: number; origin_z: number; dtype: keyof typeof DTYPES; data: Buffer }
      | undefined;
    if (!row) return null;
    const Ctor = DTYPES[row.dtype];
    const data = new Ctor(row.width * row.depth);
    new Uint8Array(data.buffer).set(row.data.subarray(0, data.byteLength)); // copy: blobs may be unaligned
    return { width: row.width, depth: row.depth, cell: row.cell, originX: row.origin_x, originZ: row.origin_z, data };
  }

  count(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  close(): void {
    if (this.ownsDb && this.db.open) this.db.close();
  }
}
