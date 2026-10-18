/**
 * TerrainCache — content-addressed, version-keyed cache for baked terrain tiles.
 *
 * A tile's bytes are a pure function of (seed, cx, cz, lod, terrainVersion,
 * surveyHash). The cache stores that key beside the tile, so has() can
 * decide whether a stored tile is current without reading its bytes.
 *
 * The bake writes tiles through this cache; the server reads them through
 * TerrainTileStore. When the survey changes, invalidateSurvey() drops every
 * tile baked under an older survey. When a region is re-baked,
 * invalidateRegion() drops just that region's tiles.
 *
 * Tiles are stored alongside terrain_tiles (LOD 0) in a separate
 * terrain_tile_data table (LOD > 0), so the existing TerrainTileStore API
 * is not broken. The key table terrain_tile_keys records the inputs each
 * tile was baked from, enabling O(1) staleness checks.
 */

import Database from "better-sqlite3";
import { TerrainTileStore } from "./terrain-tiles.js";
import { heightsFingerprint } from "../procgen/chunk-source.js";

export interface TerrainCacheOptions {
  /** Path to world.db. */
  dbPath: string;
  /** The terrain pass version; bumping it invalidates every cached tile. */
  terrainVersion: number;
  /** Minimum chunk coordinate (required for invalidateRegion). */
  minChunk?: number;
  /** World size in chunks (required for invalidateRegion). */
  sizeChunks?: number;
}

const KEY_DDL = `
  CREATE TABLE IF NOT EXISTS terrain_tile_keys (
    cx INTEGER NOT NULL,
    cz INTEGER NOT NULL,
    lod INTEGER NOT NULL,
    seed TEXT NOT NULL,
    survey_hash TEXT NOT NULL,
    terrain_version INTEGER NOT NULL,
    height_fingerprint INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (cx, cz, lod)
  );
`;

const DATA_DDL = `
  CREATE TABLE IF NOT EXISTS terrain_tile_data (
    cx INTEGER NOT NULL,
    cz INTEGER NOT NULL,
    lod INTEGER NOT NULL,
    heights BLOB NOT NULL,
    PRIMARY KEY (cx, cz, lod)
  );
`;

export class TerrainCache {
  private readonly db: Database.Database;
  private readonly store: TerrainTileStore;
  private readonly terrainVersion: number;
  private readonly minChunk: number | undefined;
  private readonly sizeChunks: number | undefined;

  private readonly getKeyStmt: Database.Statement;
  private readonly putKeyStmt: Database.Statement;
  private readonly putTileStmt: Database.Statement;
  private readonly putTileDataStmt: Database.Statement;
  private readonly deleteTilesBySurveyStmt: Database.Statement;
  private readonly deleteTileDataBySurveyStmt: Database.Statement;
  private readonly deleteKeysBySurveyStmt: Database.Statement;
  private readonly deleteTilesByRegionStmt: Database.Statement;
  private readonly deleteTileDataByRegionStmt: Database.Statement;
  private readonly deleteKeysByRegionStmt: Database.Statement;
  private readonly countKeysByRegionStmt: Database.Statement;

  constructor(opts: TerrainCacheOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.store = new TerrainTileStore(this.db);
    this.terrainVersion = opts.terrainVersion;
    this.minChunk = opts.minChunk;
    this.sizeChunks = opts.sizeChunks;

    this.db.exec(KEY_DDL);
    this.db.exec(DATA_DDL);

    this.getKeyStmt = this.db.prepare(
      "SELECT seed, survey_hash, terrain_version FROM terrain_tile_keys WHERE cx = ? AND cz = ? AND lod = ?",
    );
    this.putKeyStmt = this.db.prepare(
      "INSERT INTO terrain_tile_keys (cx, cz, lod, seed, survey_hash, terrain_version, height_fingerprint) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(cx, cz, lod) DO UPDATE SET " +
        "seed = excluded.seed, survey_hash = excluded.survey_hash, " +
        "terrain_version = excluded.terrain_version, height_fingerprint = excluded.height_fingerprint",
    );
    this.putTileStmt = this.db.prepare(
      "INSERT INTO terrain_tiles (cx, cz, heights) VALUES (?, ?, ?) " +
        "ON CONFLICT(cx, cz) DO UPDATE SET heights = excluded.heights",
    );
    this.putTileDataStmt = this.db.prepare(
      "INSERT INTO terrain_tile_data (cx, cz, lod, heights) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(cx, cz, lod) DO UPDATE SET heights = excluded.heights",
    );
    this.deleteTilesBySurveyStmt = this.db.prepare(
      "DELETE FROM terrain_tiles WHERE EXISTS (" +
        "  SELECT 1 FROM terrain_tile_keys k " +
        "  WHERE k.cx = terrain_tiles.cx AND k.cz = terrain_tiles.cz AND k.lod = 0 AND k.survey_hash != ?" +
        ")",
    );
    this.deleteTileDataBySurveyStmt = this.db.prepare(
      "DELETE FROM terrain_tile_data WHERE EXISTS (" +
        "  SELECT 1 FROM terrain_tile_keys k " +
        "  WHERE k.cx = terrain_tile_data.cx AND k.cz = terrain_tile_data.cz AND k.lod = terrain_tile_data.lod AND k.survey_hash != ?" +
        ")",
    );
    this.deleteKeysBySurveyStmt = this.db.prepare(
      "DELETE FROM terrain_tile_keys WHERE survey_hash != ?",
    );
    this.deleteTilesByRegionStmt = this.db.prepare(
      "DELETE FROM terrain_tiles WHERE cx BETWEEN ? AND ? AND cz BETWEEN ? AND ?",
    );
    this.deleteTileDataByRegionStmt = this.db.prepare(
      "DELETE FROM terrain_tile_data WHERE cx BETWEEN ? AND ? AND cz BETWEEN ? AND ?",
    );
    this.deleteKeysByRegionStmt = this.db.prepare(
      "DELETE FROM terrain_tile_keys WHERE cx BETWEEN ? AND ? AND cz BETWEEN ? AND ?",
    );
    this.countKeysByRegionStmt = this.db.prepare(
      "SELECT COUNT(*) AS n FROM terrain_tile_keys WHERE cx BETWEEN ? AND ? AND cz BETWEEN ? AND ?",
    );
  }

  /** True when the stored tile for (cx, cz, lod) was baked from exactly these inputs. */
  has(cx: number, cz: number, lod: number, seed: bigint, surveyHash: string): boolean {
    const row = this.getKeyStmt.get(cx, cz, lod) as
      | { seed: string; survey_hash: string; terrain_version: number }
      | undefined;
    if (!row) return false;
    return (
      row.seed === seed.toString() &&
      row.survey_hash === surveyHash &&
      row.terrain_version === this.terrainVersion
    );
  }

  /**
   * Store a tile. No-op (returns false) when the stored bytes already match.
   * Writes the tile and its key in ONE transaction.
   */
  put(cx: number, cz: number, lod: number, seed: bigint, surveyHash: string, heights: Float32Array): boolean {
    if (this.has(cx, cz, lod, seed, surveyHash)) return false;

    const blob = Buffer.from(heights.buffer, heights.byteOffset, heights.byteLength);
    const fingerprint = heightsFingerprint(heights);

    const tx = this.db.transaction(() => {
      if (lod === 0) {
        this.putTileStmt.run(cx, cz, blob);
      } else {
        this.putTileDataStmt.run(cx, cz, lod, blob);
      }
      this.putKeyStmt.run(cx, cz, lod, seed.toString(), surveyHash, this.terrainVersion, fingerprint);
    });
    tx();
    return true;
  }

  /**
   * Drop every tile baked under a different survey hash. Returns the count dropped.
   */
  invalidateSurvey(surveyHash: string): number {
    const count = (
      this.db.prepare("SELECT COUNT(*) AS n FROM terrain_tile_keys WHERE survey_hash != ?").get(surveyHash) as {
        n: number;
      }
    ).n;

    if (count === 0) return 0;

    const tx = this.db.transaction(() => {
      this.deleteTilesBySurveyStmt.run(surveyHash);
      this.deleteTileDataBySurveyStmt.run(surveyHash);
      this.deleteKeysBySurveyStmt.run(surveyHash);
    });
    tx();
    return count;
  }

  /**
   * Drop one region's tiles. regionsPerSide partitions the world square.
   * A region is a sizeChunks/regionsPerSide square of chunks.
   */
  invalidateRegion(rx: number, rz: number, regionsPerSide: number): number {
    if (this.minChunk === undefined || this.sizeChunks === undefined) {
      throw new Error("TerrainCache: minChunk and sizeChunks must be set to use invalidateRegion");
    }

    const per = this.sizeChunks / regionsPerSide;
    const cx0 = this.minChunk + rx * per;
    const cx1 = this.minChunk + (rx + 1) * per - 1;
    const cz0 = this.minChunk + rz * per;
    const cz1 = this.minChunk + (rz + 1) * per - 1;

    const count = (this.countKeysByRegionStmt.get(cx0, cx1, cz0, cz1) as { n: number }).n;

    if (count === 0) return 0;

    const tx = this.db.transaction(() => {
      this.deleteTilesByRegionStmt.run(cx0, cx1, cz0, cz1);
      this.deleteTileDataByRegionStmt.run(cx0, cx1, cz0, cz1);
      this.deleteKeysByRegionStmt.run(cx0, cx1, cz0, cz1);
    });
    tx();
    return count;
  }

  close(): void {
    this.store.close();
    if (this.db.open) this.db.close();
  }
}
