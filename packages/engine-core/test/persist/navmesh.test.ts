// NavmeshTileRegistry tests (Phase 2, slice 2.1): content-addressed
// tile cache + SQLite metadata registry. Blobs live on the filesystem;
// only metadata enters SQLite, and tiles never enter world snapshots.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NavmeshTileRegistry,
  tileContentHash,
  type NavmeshTileKey,
} from "../../src/persist/navmesh.js";

function key(over: Partial<NavmeshTileKey> = {}): NavmeshTileKey {
  return {
    worldSeed: "1234",
    chunkX: 0,
    chunkZ: 0,
    terrainVersion: 1,
    agentProfile: 0,
    bakeConfigHash: "abc",
    ...over,
  };
}

describe("NavmeshTileRegistry", () => {
  let dir: string;
  let reg: NavmeshTileRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "navmesh-test-"));
    reg = new NavmeshTileRegistry({ dir });
  });

  afterEach(() => {
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("register -> lookup -> loadBlob round-trips the bytes", () => {
    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    const record = reg.register(key(), blob);
    assert.equal(record.blobSha256, tileContentHash(blob));
    assert.equal(record.byteSize, 5);

    const found = reg.lookup(key());
    assert.ok(found, "lookup hits after register");
    assert.equal(found.blobSha256, record.blobSha256);

    const loaded = reg.loadBlob(found);
    assert.ok(loaded, "blob loads");
    assert.deepEqual([...loaded], [1, 2, 3, 4, 5]);
  });

  it("lookup misses on unknown keys", () => {
    assert.equal(reg.lookup(key()), undefined);
    reg.register(key(), new Uint8Array([9]));
    assert.equal(reg.lookup(key({ chunkX: 99 })), undefined);
  });

  it("identical blobs deduplicate to one file across keys", () => {
    const blob = new Uint8Array([7, 7, 7]);
    const r1 = reg.register(key({ chunkX: 0 }), blob);
    const r2 = reg.register(key({ chunkX: 1 }), blob);
    assert.equal(r1.blobSha256, r2.blobSha256);
    assert.equal(reg.tilePath(r1.blobSha256), reg.tilePath(r2.blobSha256));
  });

  it("re-registering a key with a new blob replaces the row", () => {
    reg.register(key(), new Uint8Array([1]));
    const r2 = reg.register(key(), new Uint8Array([2, 2]));
    const found = reg.lookup(key());
    assert.ok(found);
    assert.equal(found.blobSha256, r2.blobSha256);
    assert.equal(found.byteSize, 2);
    assert.deepEqual([...reg.loadBlob(found)!], [2, 2]);
  });

  it("missing blob file is a cache miss, not an error", () => {
    const record = reg.register(key(), new Uint8Array([1, 2, 3]));
    rmSync(reg.tilePath(record.blobSha256));
    assert.equal(reg.loadBlob(record), undefined);
  });

  it("corrupt blob file is treated as a miss and removed", () => {
    const record = reg.register(key(), new Uint8Array([1, 2, 3]));
    writeFileSync(reg.tilePath(record.blobSha256), new Uint8Array([9, 9, 9]));
    assert.equal(reg.loadBlob(record), undefined, "hash mismatch -> miss");
    // Self-heal: the corrupt file is gone so the next bake re-populates.
    const record2 = reg.register(key(), new Uint8Array([1, 2, 3]));
    assert.deepEqual([...reg.loadBlob(record2)!], [1, 2, 3]);
  });

  it("different bake config hashes are different cache entries", () => {
    reg.register(key({ bakeConfigHash: "aaa" }), new Uint8Array([1]));
    reg.register(key({ bakeConfigHash: "bbb" }), new Uint8Array([2, 2]));
    assert.equal(reg.lookup(key({ bakeConfigHash: "aaa" }))!.byteSize, 1);
    assert.equal(reg.lookup(key({ bakeConfigHash: "bbb" }))!.byteSize, 2);
  });

  it("listKeys returns every registered key (editor tile-bounds overlay)", () => {
    assert.deepEqual(reg.listKeys(), [], "empty registry");
    reg.register(key({ chunkX: 0, chunkZ: 0 }), new Uint8Array([1]));
    reg.register(key({ chunkX: 1, chunkZ: 0 }), new Uint8Array([2]));
    const keys = reg.listKeys();
    assert.equal(keys.length, 2);
    const chunks = keys
      .map((k) => [k.chunkX, k.chunkZ])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    assert.deepEqual(chunks, [
      [0, 0],
      [1, 0],
    ]);
    // Re-registering the same key does not duplicate it.
    reg.register(key({ chunkX: 0, chunkZ: 0 }), new Uint8Array([3]));
    assert.equal(reg.listKeys().length, 2);
  });
});
