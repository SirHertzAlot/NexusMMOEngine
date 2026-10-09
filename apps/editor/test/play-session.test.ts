/** The play session's working copy of the world (EA14): users.csv is never copied, fresh keeps terrain only, keep writes back. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountNames, finishSession, isStateFile, prepareSession, SESSION_DIR_NAME, type OpenDb, type SqliteLike } from "../src/play-session.js";

function world(): string {
  const dir = mkdtempSync(join(tmpdir(), "mmo-session-"));
  writeFileSync(join(dir, "users.csv"), "REAL ACCOUNTS");
  writeFileSync(join(dir, "world.db"), "world");
  writeFileSync(join(dir, "world.db-wal"), "wal");
  writeFileSync(join(dir, "characters.db"), "chars");
  writeFileSync(join(dir, "editor-login.json"), "{}");
  mkdirSync(join(dir, "navmesh"));
  writeFileSync(join(dir, "navmesh", "t0.bin"), "mesh");
  return dir;
}
const noDb: OpenDb = async () => {
  throw new Error("not opened for a saved-world session");
};

describe("play session", () => {
  it("recognises state files", () => {
    for (const n of ["world.db", "world.db-wal", "world.db-shm", "characters.db"]) assert.ok(isStateFile(n), n);
    for (const n of ["users.csv", "navmesh", "pool.jsonl"]) assert.ok(!isStateFile(n), n);
  });

  it("continue-saved copies state and baked data but never the real accounts", async () => {
    const data = world();
    const dir = await prepareSession({ dataDir: data, fresh: false, openDb: noDb });
    assert.equal(dir, join(data, SESSION_DIR_NAME));
    for (const f of ["world.db", "world.db-wal", "characters.db", join("navmesh", "t0.bin")]) assert.ok(existsSync(join(dir, f)), f);
    assert.ok(!existsSync(join(dir, "users.csv")));
    assert.ok(!existsSync(join(dir, "editor-login.json")));
    assert.equal(readFileSync(join(data, "users.csv"), "utf8"), "REAL ACCOUNTS");
    rmSync(data, { recursive: true });
  });

  it("fresh copies world.db for its terrain, empties the rest and drops every other state file", async () => {
    const data = world();
    const deleted: string[] = [];
    const db: SqliteLike = {
      prepare: () => ({
        all: () => ["terrain_tiles", "chunk_entities", "item_events", "navmesh_tiles", "meta"].map((name) => ({ name })),
        run: () => undefined,
      }),
      exec: (sql) => void deleted.push(sql),
      close: () => deleted.push("closed"),
    };
    const dir = await prepareSession({ dataDir: data, fresh: true, openDb: async () => db });
    assert.ok(existsSync(join(dir, "world.db")));
    assert.ok(!existsSync(join(dir, "characters.db")));
    assert.ok(existsSync(join(dir, "navmesh", "t0.bin")));
    assert.deepEqual(deleted.filter((s) => s.startsWith("DELETE FROM \"")), ['DELETE FROM "chunk_entities"', 'DELETE FROM "item_events"']);
    assert.ok(deleted.includes("closed"));
    rmSync(data, { recursive: true });
  });

  it("stop discards the session, or with keep writes its state over the saved world", async () => {
    const data = world();
    let dir = await prepareSession({ dataDir: data, fresh: false, openDb: noDb });
    writeFileSync(join(dir, "world.db"), "played");
    rmSync(join(dir, "world.db-wal"));
    assert.deepEqual(finishSession(data, false).kept, []);
    assert.ok(!existsSync(dir));
    assert.equal(readFileSync(join(data, "world.db"), "utf8"), "world");

    dir = await prepareSession({ dataDir: data, fresh: false, openDb: noDb });
    writeFileSync(join(dir, "world.db"), "played");
    rmSync(join(dir, "world.db-wal"));
    const { kept } = finishSession(data, true);
    assert.ok(kept.includes("world.db"));
    assert.equal(readFileSync(join(data, "world.db"), "utf8"), "played");
    // The stale WAL beside the old file would corrupt the new one, so it went.
    assert.ok(!existsSync(join(data, "world.db-wal")));
    assert.equal(readFileSync(join(data, "users.csv"), "utf8"), "REAL ACCOUNTS");
    assert.ok(!existsSync(dir));
    rmSync(data, { recursive: true });
  });

  it("names one account per client", () => {
    assert.deepEqual(accountNames(3), ["play-1", "play-2", "play-3"]);
  });
});
