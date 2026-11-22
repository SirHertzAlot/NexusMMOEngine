/**
 * On-disk atomic binary persistence for `SpawnPoolSoA` (Track P2).
 *
 * Writes via a unique temporary file in the target directory + `fsyncSync` +
 * `renameSync` so a crash mid-write never corrupts the existing on-disk pool.
 * Loads fail-closed through `SpawnPoolSoA.decodeBinary`, verifying `"MMOS"`
 * magic, version, header bounds, IEEE 802.3 CRC-32 checksum, and L2 budget.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  SpawnPoolSoA,
  type DecodeSpawnPoolOptions,
} from "./spawn-pool-soa.js";

export interface SaveSpawnPoolResult {
  filePath: string;
  bytesWritten: number;
  activeCount: number;
  highWater: number;
}

/**
 * Atomically persist a `SpawnPoolSoA` binary image to `filePath`.
 * Writes to a sibling temporary file in the same directory, flushes to disk,
 * and replaces `filePath` via `fs.renameSync`.
 */
export function saveSpawnPoolToDisk(
  filePath: string,
  pool: SpawnPoolSoA,
): SaveSpawnPoolResult {
  if (!filePath || typeof filePath !== "string") {
    throw new TypeError("saveSpawnPoolToDisk: filePath must be a non-empty string");
  }
  if (!(pool instanceof SpawnPoolSoA)) {
    throw new TypeError("saveSpawnPoolToDisk: expected a SpawnPoolSoA instance");
  }

  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);
  fs.mkdirSync(dir, { recursive: true });

  const encoded = pool.encodeBinary();
  const nonce = crypto.randomBytes(6).toString("hex");
  const tmpPath = path.join(dir, `.${path.basename(resolvedPath)}.tmp.${process.pid}.${nonce}`);

  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, "w");
    let offset = 0;
    while (offset < encoded.byteLength) {
      offset += fs.writeSync(fd, encoded, offset, encoded.byteLength - offset);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    fs.renameSync(tmpPath, resolvedPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors during rollback.
      }
    }
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore temp cleanup errors during rollback.
    }
    throw err;
  }

  return {
    filePath: resolvedPath,
    bytesWritten: encoded.byteLength,
    activeCount: pool.activeCount,
    highWater: pool.highWater,
  };
}

/**
 * Read a `"MMOS"` v1 binary pool file directly into a `SharedArrayBuffer`-backed
 * `SpawnPoolSoA`, verifying magic, version, header invariants, CRC-32 checksum,
 * and L2 cache byte ceiling (fail-closed).
 */
export function loadSpawnPoolFromDisk(
  filePath: string,
  opts?: DecodeSpawnPoolOptions,
): SpawnPoolSoA {
  if (!filePath || typeof filePath !== "string") {
    throw new TypeError("loadSpawnPoolFromDisk: filePath must be a non-empty string");
  }
  const resolvedPath = path.resolve(filePath);
  const raw = fs.readFileSync(resolvedPath);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return SpawnPoolSoA.decodeBinary(bytes, opts);
}
