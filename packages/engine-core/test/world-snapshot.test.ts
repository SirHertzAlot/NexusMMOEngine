/**
 * TDD: World snapshot/restore for the Play menu's fresh/keep options.
 *
 * - "Fresh state": before the owned server starts, the current world.db
 *   is backed up and a clean world starts. On stop, the backup is
 *   restored unless "keep play changes" is set.
 * - "Keep play changes": the world keeps what the tick wrote (the
 *   backup is discarded on stop).
 *
 * Pure file operations; the server control wires them around start/stop.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupWorld, restoreWorld, discardBackup, snapshotPath } from "../src/world-snapshot.js";

describe("world snapshot", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsnap-"));
    dbPath = join(dir, "world.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("backupWorld copies the db to the snapshot path", () => {
    writeFileSync(dbPath, "world-data-v1");
    const snap = backupWorld(dbPath);
    assert.equal(readFileSync(snap, "utf8"), "world-data-v1");
    assert.equal(snap, snapshotPath(dbPath));
  });

  it("backupWorld is a no-op when the db does not exist", () => {
    const snap = backupWorld(dbPath);
    assert.equal(snap, snapshotPath(dbPath));
    // No file created, no throw.
  });

  it("restoreWorld puts the backup back", () => {
    writeFileSync(dbPath, "original");
    backupWorld(dbPath);
    writeFileSync(dbPath, "play-changes");
    restoreWorld(dbPath);
    assert.equal(readFileSync(dbPath, "utf8"), "original");
  });

  it("restoreWorld is a no-op when there is no backup", () => {
    writeFileSync(dbPath, "untouched");
    restoreWorld(dbPath); // no throw
    assert.equal(readFileSync(dbPath, "utf8"), "untouched");
  });

  it("discardBackup removes the snapshot", () => {
    writeFileSync(dbPath, "x");
    const snap = backupWorld(dbPath);
    discardBackup(dbPath);
    assert.throws(() => readFileSync(snap), /ENOENT/);
  });

  it("snapshotPath is the db path with .bak", () => {
    assert.equal(snapshotPath("/a/world.db"), "/a/world.db.bak");
  });
});
