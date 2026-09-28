/**
 * navmesh.ts — content-addressed navmesh tile store (Phase 2).
 *
 * Baked tiles are versioned deterministic build artifacts, NOT world
 * state: tile blobs never enter world snapshots. The SQLite registry
 * holds lookup metadata keyed by
 * (worldSeed, chunkX, chunkZ, terrainVersion, agentProfile,
 * bakeConfigHash); the blob itself lives on the filesystem under its
 * sha256, so identical tiles across chunks/versions deduplicate to one
 * file.
 *
 * Corrupt blobs (hash mismatch) are treated as cache misses and the
 * bad file is removed so the next bake re-populates it.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Registry lookup key — everything that can change a tile's bytes. */
export interface NavmeshTileKey {
  worldSeed: string;
  chunkX: number;
  chunkZ: number;
  terrainVersion: number;
  agentProfile: number;
  bakeConfigHash: string;
}

export interface NavmeshTileRecord extends NavmeshTileKey {
  blobSha256: string;
  byteSize: number;
  bakedAt: number;
}

export interface NavmeshTileRegistryOptions {
  /** Directory holding navmesh.db + tile blob files. Created if missing. */
  dir: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS navmesh_tiles (
  world_seed       TEXT    NOT NULL,
  chunk_x          INTEGER NOT NULL,
  chunk_z          INTEGER NOT NULL,
  terrain_version  INTEGER NOT NULL,
  agent_profile    INTEGER NOT NULL,
  bake_config_hash TEXT    NOT NULL,
  blob_sha256      TEXT    NOT NULL,
  byte_size        INTEGER NOT NULL,
  baked_at         INTEGER NOT NULL,
  PRIMARY KEY (world_seed, chunk_x, chunk_z, terrain_version, agent_profile, bake_config_hash)
);
CREATE INDEX IF NOT EXISTS navmesh_tiles_blob
  ON navmesh_tiles (blob_sha256);
`;

export function tileContentHash(blob: Uint8Array): string {
  return createHash("sha256").update(blob).digest("hex");
}

export class NavmeshTileRegistry {
  private readonly db: Database.Database;
  private readonly blobDir: string;
  private readonly stmtGet: Database.Statement;
  private readonly stmtPut: Database.Statement;

  constructor(options: NavmeshTileRegistryOptions) {
    mkdirSync(options.dir, { recursive: true });
    this.blobDir = join(options.dir, "tiles");
    mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(join(options.dir, "navmesh.db"));
    // A rebuildable cache, written while chunks stream in on the tick
    // thread: WAL + NORMAL skips the per-insert fsync (~14 ms on Windows).
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this.stmtGet = this.db.prepare(`
      SELECT world_seed AS worldSeed, chunk_x AS chunkX, chunk_z AS chunkZ,
             terrain_version AS terrainVersion, agent_profile AS agentProfile,
             bake_config_hash AS bakeConfigHash, blob_sha256 AS blobSha256,
             byte_size AS byteSize, baked_at AS bakedAt
      FROM navmesh_tiles
      WHERE world_seed = @worldSeed AND chunk_x = @chunkX AND chunk_z = @chunkZ
        AND terrain_version = @terrainVersion AND agent_profile = @agentProfile
        AND bake_config_hash = @bakeConfigHash
    `);
    this.stmtPut = this.db.prepare(`
      INSERT INTO navmesh_tiles
        (world_seed, chunk_x, chunk_z, terrain_version, agent_profile,
         bake_config_hash, blob_sha256, byte_size, baked_at)
      VALUES
        (@worldSeed, @chunkX, @chunkZ, @terrainVersion, @agentProfile,
         @bakeConfigHash, @blobSha256, @byteSize, @bakedAt)
      ON CONFLICT (world_seed, chunk_x, chunk_z, terrain_version,
                   agent_profile, bake_config_hash)
      DO UPDATE SET blob_sha256 = excluded.blob_sha256,
                    byte_size = excluded.byte_size,
                    baked_at = excluded.baked_at
    `);
  }

  /** Filesystem path for a blob (content-addressed by sha256). */
  tilePath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new RangeError(`invalid tile sha256: ${sha256}`);
    }
    return join(this.blobDir, `${sha256}.tile`);
  }

  /** Registry metadata for a key, or undefined on a miss. */
  lookup(key: NavmeshTileKey): NavmeshTileRecord | undefined {
    return this.stmtGet.get(key) as NavmeshTileRecord | undefined;
  }

  /** All registered tile keys (editor-only debug: tile bounds overlay). */
  listKeys(): NavmeshTileKey[] {
    return this.db
      .prepare(
        `SELECT world_seed AS worldSeed, chunk_x AS chunkX, chunk_z AS chunkZ,
                terrain_version AS terrainVersion, agent_profile AS agentProfile,
                bake_config_hash AS bakeConfigHash
         FROM navmesh_tiles`,
      )
      .all() as NavmeshTileKey[];
  }

  /**
   * Register a baked tile: write the blob file if missing (dedup by
   * content hash) and upsert the registry row. Returns the record.
   */
  register(key: NavmeshTileKey, blob: Uint8Array): NavmeshTileRecord {
    const sha = tileContentHash(blob);
    const path = this.tilePath(sha);
    if (!existsSync(path)) {
      // Atomic write: temp file + rename, so a crash never leaves a
      // half-written tile that a later lookup would trust.
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, blob);
      renameSync(tmp, path);
    }
    const record: NavmeshTileRecord = {
      ...key,
      blobSha256: sha,
      byteSize: blob.length,
      bakedAt: Date.now(),
    };
    this.stmtPut.run(record);
    return record;
  }

  /**
   * Load a tile blob by record. Returns undefined when the file is
   * missing or fails its hash check (treated as a cache miss); a
   * corrupt file is removed so the next bake re-populates it.
   */
  loadBlob(record: NavmeshTileRecord): Uint8Array | undefined {
    const path = this.tilePath(record.blobSha256);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      return undefined;
    }
    if (
      bytes.length !== record.byteSize ||
      tileContentHash(bytes) !== record.blobSha256
    ) {
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
      return undefined;
    }
    return bytes;
  }

  close(): void {
    this.db.close();
  }
}
