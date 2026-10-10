/**
 * play-snapshot: the world.db backup around one owned play server
 * (Play menu fresh/keep), with real files in a temp dir.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlaySnapshot } from "../src/play-snapshot.js";

describe("play-snapshot", () => {
  let dir: string;
  let db: string;
  const read = (): string => readFileSync(db, "utf8");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "play-snap-"));
    db = join(dir, "world.db");
    writeFileSync(db, "authored");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("not keeping play changes: the world comes back on stop", () => {
    const snap = createPlaySnapshot(db);
    snap.begin({ fresh: false, keep: false });
    writeFileSync(db, "played");
    snap.end();
    assert.equal(read(), "authored");
  });

  it("fresh without keep: the world comes back on stop", () => {
    const snap = createPlaySnapshot(db);
    snap.begin({ fresh: true, keep: false });
    writeFileSync(db, "played");
    snap.end();
    assert.equal(read(), "authored");
  });

  it("keeping play changes: the world keeps what play wrote, no backup left", () => {
    for (const fresh of [true, false]) {
      writeFileSync(db, "authored");
      const snap = createPlaySnapshot(db);
      snap.begin({ fresh, keep: true });
      writeFileSync(db, "played");
      snap.end();
      assert.equal(read(), "played");
      assert.equal(existsSync(`${db}.bak`), false, `fresh=${fresh}`);
    }
  });

  it("a failed start puts the world back and the next start backs up the real world", () => {
    const snap = createPlaySnapshot(db);
    snap.begin({ fresh: true, keep: false });
    writeFileSync(db, "half-started");
    snap.fail();
    assert.equal(read(), "authored");
    snap.begin({ fresh: true, keep: false });
    writeFileSync(db, "played");
    snap.end();
    assert.equal(read(), "authored");
  });

  it("a backup left by a host that died mid-play is restored, not discarded", () => {
    createPlaySnapshot(db).begin({ fresh: true, keep: false });
    writeFileSync(db, "played-then-crashed");
    // A new host process: fresh bookkeeping, the old backup still on disk.
    const snap = createPlaySnapshot(db);
    const note = snap.begin({ fresh: false, keep: true });
    assert.match(note ?? "", /restored/);
    assert.equal(read(), "authored");
    assert.equal(existsSync(`${db}.bak`), false);
  });

  it("stop and fail without a begin do nothing", () => {
    const snap = createPlaySnapshot(db);
    snap.end();
    snap.fail();
    assert.equal(read(), "authored");
  });
});
