/**
 * region.db: the region's local hot cache. An earlier build's world.db
 * (with its WAL sidecars and play backup) is renamed on first open; an
 * existing region.db is never overwritten.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyRegionDb, REGION_DB_FILE } from "../../src/persist/region-db.js";

describe("region.db migration", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "region-db-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renames world.db with its sidecars and play backup", () => {
    for (const f of ["world.db", "world.db-wal", "world.db-shm", "world.db.bak", "world.db.bak-wal"]) {
      writeFileSync(join(dir, f), f);
    }
    assert.equal(migrateLegacyRegionDb(dir), "renamed");
    assert.equal(REGION_DB_FILE, "region.db");
    for (const f of ["region.db", "region.db-wal", "region.db-shm", "region.db.bak", "region.db.bak-wal"]) {
      assert.equal(readFileSync(join(dir, f), "utf8"), f.replace("region", "world"));
    }
    for (const f of ["world.db", "world.db-wal", "world.db.bak"]) assert.equal(existsSync(join(dir, f)), false);
  });

  it("does nothing when there is no legacy file", () => {
    assert.equal(migrateLegacyRegionDb(dir), "none");
    assert.equal(existsSync(join(dir, "region.db")), false);
  });

  it("never overwrites an existing region.db", () => {
    writeFileSync(join(dir, "world.db"), "old");
    writeFileSync(join(dir, "region.db"), "new");
    assert.equal(migrateLegacyRegionDb(dir), "both-present");
    assert.equal(readFileSync(join(dir, "region.db"), "utf8"), "new");
    assert.equal(readFileSync(join(dir, "world.db"), "utf8"), "old");
  });
});
