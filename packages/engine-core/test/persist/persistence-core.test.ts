/**
 * PersistenceCore (roadmap EA16): catalog, bounded read-only query, typed
 * mutations with admin_log and undo. Temp databases only.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PersistenceCore, PersistenceError, type Mutation } from "../../src/persist/persistence-core.js";

let dir: string;
let core: PersistenceCore;
let running = false;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcore-"));
  const d = new Database(path.join(dir, "characters.db"));
  d.pragma("journal_mode = WAL");
  d.exec(`CREATE TABLE characters (id INTEGER PRIMARY KEY, name TEXT NOT NULL, health REAL, note TEXT, icon BLOB);
    INSERT INTO characters (id, name, health, note) VALUES (1, 'alice', 50, NULL), (2, 'bob', 70, 'x');
    CREATE TABLE nokey (a TEXT);`);
  d.close();
  const w = new Database(path.join(dir, "world.db"));
  w.exec("CREATE TABLE item_events (id INTEGER PRIMARY KEY, kind INTEGER); INSERT INTO item_events VALUES (1, 0);");
  w.close();
  running = false;
  core = new PersistenceCore({ dataDir: dir, isServerRunning: () => running });
});
afterEach(() => {
  core.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 32, retryDelay: 50 });
});

const rejects = (p: Promise<unknown>, code: string): Promise<void> =>
  assert.rejects(p, (e) => e instanceof PersistenceError && e.code === code);

describe("catalog", () => {
  it("lists databases, tables, columns and row counts", () => {
    const cat = core.catalog();
    assert.deepEqual(cat.map((d) => d.name).sort(), ["characters", "world"]);
    const t = cat.find((d) => d.name === "characters")!.tables.find((x) => x.name === "characters")!;
    assert.equal(t.rowCount, 2);
    assert.equal(t.editable, true);
    assert.deepEqual(t.columns.map((c) => [c.name, c.pk, c.editable]), [
      ["id", 1, false], ["name", 0, true], ["health", 0, true], ["note", 0, true], ["icon", 0, false],
    ]);
  });
  it("marks append-only and keyless tables read-only", () => {
    const cat = core.catalog();
    assert.equal(cat.find((d) => d.name === "world")!.tables[0].editable, false);
    assert.equal(cat.find((d) => d.name === "characters")!.tables.find((x) => x.name === "nokey")!.editable, false);
  });
});

describe("query", () => {
  it("returns rows for a SELECT", async () => {
    const r = await core.query("characters", "SELECT name FROM characters ORDER BY id");
    assert.deepEqual(r.rows, [["alice"], ["bob"]]);
  });
  for (const sql of [
    "DELETE FROM characters",
    "UPDATE characters SET health = 0",
    "DROP TABLE characters",
    "PRAGMA journal_mode = DELETE",
    "SELECT 1; DELETE FROM characters",
    "WITH x AS (SELECT 1) DELETE FROM characters",
  ]) {
    it(`refuses: ${sql}`, async () => {
      await rejects(core.query("characters", sql), "refused");
      assert.equal(core.catalog().find((d) => d.name === "characters")!.tables[0].rowCount, 2);
    });
  }
  it("caps rows at the limit and says so", async () => {
    const r = await core.query("characters", "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 100000) SELECT i FROM n", { limit: 10 });
    assert.equal(r.rows.length, 10);
    assert.equal(r.truncated, true);
  });
  it("takes its row caps from the server settings, read on each query (EG13)", async () => {
    let caps = { defaultRows: 3, maxRows: 5, timeoutMs: 2000 };
    const limited = new PersistenceCore({ dataDir: dir, queryLimits: () => caps });
    try {
      const many = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 100) SELECT i FROM n";
      assert.equal((await limited.query("characters", many)).rows.length, 3, "the default rows");
      assert.equal((await limited.query("characters", many, { limit: 50 })).rows.length, 5, "capped at the most rows");
      caps = { ...caps, defaultRows: 4 };
      assert.equal((await limited.query("characters", many)).rows.length, 4, "a changed setting applies to the next query");
    } finally {
      limited.close();
    }
  });
  it("stops a heavy query at the timeout", async () => {
    const t0 = Date.now();
    await rejects(
      core.query("characters", "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n) SELECT count(*) FROM n", { timeoutMs: 300 }),
      "timeout",
    );
    assert.ok(Date.now() - t0 < 3000);
  });
});

describe("mutations", () => {
  const edit = { db: "characters", table: "characters", key: { id: 1 }, set: { health: 99 } };

  it("persists an edit, logs the before-image, backs up, and undoes", async () => {
    const [e] = await core.apply("admin1", [edit]);
    const read = () => core.query("characters", "SELECT health FROM characters WHERE id = 1").then((r) => r.rows[0][0]);
    assert.equal(await read(), 99);
    assert.deepEqual([e.before, e.after, e.admin], [{ health: 50 }, { health: 99 }, "admin1"]);
    assert.equal(core.log().length, 1);
    assert.ok(fs.readdirSync(path.join(dir, "backups")).some((f) => f.startsWith("characters-")));

    const u = await core.undo("admin1", e.id);
    assert.equal(await read(), 50);
    assert.equal(u.op, "undo");
    assert.equal(core.log().find((x) => x.id === e.id)!.undoneBy, u.id);
    await rejects(core.undo("admin1", e.id), "conflict");
  });
  it("refuses an undo when the row changed since", async () => {
    const [a] = await core.apply("a", [edit]);
    await core.apply("a", [{ ...edit, set: { health: 5 } }]);
    await rejects(core.undo("a", a.id), "conflict");
  });
  it("validates schema: unknown column, primary key, blob, type, null, key, table", async () => {
    for (const bad of <Mutation[]>[
      { ...edit, set: { nope: 1 } },
      { ...edit, set: { id: 9 } },
      { ...edit, set: { icon: "x" } },
      { ...edit, set: { health: "high" } },
      { ...edit, set: { name: null } },
      { ...edit, key: { name: "alice" } },
      { ...edit, table: "nokey", key: {}, set: { a: "x" } },
      { ...edit, db: "world", table: "item_events", key: { id: 1 }, set: { kind: 2 } },
      { ...edit, db: "../etc" },
      { ...edit, key: { id: 404 } },
    ]) {
      await assert.rejects(core.apply("a", [bad]), PersistenceError);
    }
    assert.equal(core.log().length, 0);
  });
  it("applies a batch atomically: one bad row writes nothing", async () => {
    await assert.rejects(core.apply("a", [edit, { ...edit, key: { id: 404 } }]));
    assert.equal((await core.query("characters", "SELECT health FROM characters WHERE id = 1")).rows[0][0], 50);
  });
  it("refuses while the game server is running", async () => {
    running = true;
    await rejects(core.apply("a", [edit]), "refused");
    assert.equal(core.log().length, 0);
  });
});
