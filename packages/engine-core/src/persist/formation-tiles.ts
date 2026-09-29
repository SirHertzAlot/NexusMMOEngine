/**
 * FormationTileStore — solved formation tiles (see procgen/formation.ts),
 * in world.db beside the terrain tiles.
 *
 * A formation tile is a deterministic build artifact of (world seed,
 * terrain, ecology plan, layer, tile): the bake solves every tile of the
 * world once and stores it here, so the server only reads them (solving a
 * tile takes tens of milliseconds, too long for the tick). A tile the
 * store doesn't have — a world baked before formations, a plan edited
 * since — is solved on demand and written back, as a cache would be.
 * Rows are keyed by everything that can change them, so a changed plan or
 * terrain simply misses.
 */

import Database from "better-sqlite3";
import type { FormationPoint, FormationTileBacking } from "../procgen/formation.js";

const DDL = `
CREATE TABLE IF NOT EXISTS formation_tiles (
  world_seed      TEXT    NOT NULL,
  terrain_version TEXT    NOT NULL,
  plan_hash       TEXT    NOT NULL,
  layer           TEXT    NOT NULL,
  ti              INTEGER NOT NULL,
  tj              INTEGER NOT NULL,
  points          BLOB    NOT NULL,
  PRIMARY KEY (world_seed, terrain_version, plan_hash, layer, ti, tj)
);
`;

/** A tile's points as bytes: per point x, z (float64), i, j (int32), option (int32). */
export function encodeFormationPoints(points: readonly FormationPoint[]): Buffer {
  const b = Buffer.alloc(points.length * 28);
  points.forEach((p, k) => {
    const o = k * 28;
    b.writeDoubleLE(p.x, o);
    b.writeDoubleLE(p.z, o + 8);
    b.writeInt32LE(p.i, o + 16);
    b.writeInt32LE(p.j, o + 20);
    b.writeInt32LE(p.option, o + 24);
  });
  return b;
}

export function decodeFormationPoints(b: Uint8Array): FormationPoint[] {
  if (b.byteLength % 28 !== 0) throw new Error(`formation tile: ${b.byteLength} bytes is not a whole number of points`);
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const out: FormationPoint[] = [];
  for (let o = 0; o < buf.length; o += 28) {
    out.push({ x: buf.readDoubleLE(o), z: buf.readDoubleLE(o + 8), i: buf.readInt32LE(o + 16), j: buf.readInt32LE(o + 20), option: buf.readInt32LE(o + 24) });
  }
  return out;
}

export class FormationTileStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;
  private readonly getStmt: Database.Statement;
  private readonly putStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  /** `autoCheckpoint: false`: leave WAL checkpoints to another connection (the server's snapshot worker), as ChunkEntityStore does. */
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
    this.getStmt = this.db.prepare(
      "SELECT points FROM formation_tiles WHERE world_seed = ? AND terrain_version = ? AND plan_hash = ? AND layer = ? AND ti = ? AND tj = ?",
    );
    this.putStmt = this.db.prepare(
      "INSERT INTO formation_tiles (world_seed, terrain_version, plan_hash, layer, ti, tj, points) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (world_seed, terrain_version, plan_hash, layer, ti, tj) DO UPDATE SET points = excluded.points",
    );
    this.countStmt = this.db.prepare("SELECT COUNT(*) AS n FROM formation_tiles WHERE world_seed = ? AND terrain_version = ? AND plan_hash = ?");
  }

  /** The store as a formation cache's backing, for one world, terrain and plan. */
  backing(key: { worldSeed: bigint; terrainVersion: string; planHash: string }): FormationTileBacking {
    const seed = key.worldSeed.toString();
    return {
      get: (layer, ti, tj) => {
        const row = this.getStmt.get(seed, key.terrainVersion, key.planHash, layer, ti, tj) as { points: Buffer } | undefined;
        return row ? decodeFormationPoints(row.points) : undefined;
      },
      put: (layer, ti, tj, points) => {
        this.putStmt.run(seed, key.terrainVersion, key.planHash, layer, ti, tj, encodeFormationPoints(points));
      },
    };
  }

  /** Tiles stored for a world, terrain and plan. */
  count(key: { worldSeed: bigint; terrainVersion: string; planHash: string }): number {
    return (this.countStmt.get(key.worldSeed.toString(), key.terrainVersion, key.planHash) as { n: number }).n;
  }

  /** Run `fn` in one transaction (the bake writes thousands of tiles). */
  transaction(fn: () => void): void {
    this.db.transaction(fn)();
  }

  close(): void {
    if (this.ownsDb && this.db.open) this.db.close();
  }
}
