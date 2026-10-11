/**
 * EA17: database functions and caches. Temp databases and temp content dirs only.
 *
 * Covers: file parsing/validation (good + hostile SQL), the loader's
 * collect-don't-throw posture, running a parameterized function through the
 * read-only child process, snapshot cache refresh (build, re-refresh,
 * freshness metadata), maintenance-mode refusal, and creating functions.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PersistenceCore, PersistenceError } from "../../src/persist/persistence-core.js";
import {
  extractParams,
  loadDbCaches,
  loadDbFunctions,
  parseCacheFile,
  parseFunctionFile,
} from "../../src/persist/db-functions.js";

const FN = `-- db: characters
-- description: Net combat score for one character.
SELECT (SELECT COUNT(*) FROM deaths WHERE killer = :character_id)
  - (SELECT COUNT(*) FROM deaths WHERE character_id = :character_id) AS power;
`;

describe("extractParams", () => {
  it("finds :name placeholders in first-seen order, deduplicated", () => {
    assert.deepEqual(extractParams("SELECT :a, :b, :a FROM t WHERE x = :c"), ["a", "b", "c"]);
  });
  it("ignores :looking text inside string literals", () => {
    assert.deepEqual(extractParams("SELECT ':not_a_param', ':also_no' FROM t WHERE id = :id"), ["id"]);
  });
  it("finds none in a plain SELECT", () => {
    assert.deepEqual(extractParams("SELECT 1"), []);
  });
});

describe("parseFunctionFile", () => {
  it("accepts a valid file: headers, cleaned SQL, params", () => {
    const { def, problems } = parseFunctionFile("character_power.sql", FN);
    assert.deepEqual(problems, []);
    assert.equal(def?.name, "character_power");
    assert.equal(def?.db, "characters");
    assert.equal(def?.description, "Net combat score for one character.");
    assert.deepEqual(def?.params, ["character_id"]);
    assert.ok(def?.sql.startsWith("SELECT"));
    assert.ok(!def?.sql.includes("--"));
  });
  it("works without a description", () => {
    const { def, problems } = parseFunctionFile("f.sql", "-- db: world\nSELECT 1;");
    assert.deepEqual(problems, []);
    assert.equal(def?.description, undefined);
  });
  for (const [label, sql] of [
    ["INSERT", "INSERT INTO t VALUES (1)"],
    ["UPDATE", "UPDATE t SET a = 1"],
    ["DELETE", "DELETE FROM t"],
    ["DROP", "DROP TABLE t"],
    ["PRAGMA", "PRAGMA journal_mode = DELETE"],
    ["two statements", "SELECT 1; SELECT 2"],
    ["empty", ""],
  ] as Array<[string, string]>) {
    it(`refuses ${label}`, () => {
      const { def, problems } = parseFunctionFile("f.sql", `-- db: world\n${sql}`);
      assert.equal(def, undefined);
      assert.ok(problems.length > 0, "expected a problem");
    });
  }
  it("refuses a missing db header", () => {
    const { def, problems } = parseFunctionFile("f.sql", "SELECT 1");
    assert.equal(def, undefined);
    assert.ok(problems.some((p) => p.message.includes('"db:"')));
  });
  it("refuses an unknown header and a bad file name", () => {
    const { problems } = parseFunctionFile("Bad Name.sql", "-- db: world\n-- frobnicate: yes\nSELECT 1");
    assert.ok(problems.some((p) => p.message.includes("unknown header")));
    assert.ok(problems.some((p) => p.message.includes("must be lowercase")));
  });
});

describe("parseCacheFile", () => {
  it("accepts a valid cache file", () => {
    const { def, problems } = parseCacheFile("leaderboard.sql", "-- db: characters\nSELECT id FROM characters LIMIT 10;");
    assert.deepEqual(problems, []);
    assert.equal(def?.name, "leaderboard");
  });
  it("refuses parameters in a cache", () => {
    const { def, problems } = parseCacheFile("c.sql", "-- db: characters\nSELECT * FROM t WHERE id = :id;");
    assert.equal(def, undefined);
    assert.ok(problems.some((p) => p.message.includes("no parameters")));
  });
});

describe("loaders", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbfn-load-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("collects problems without failing the good files", () => {
    fs.writeFileSync(path.join(dir, "good.sql"), FN);
    fs.writeFileSync(path.join(dir, "evil.sql"), "-- db: world\nDROP TABLE t;");
    fs.writeFileSync(path.join(dir, "nope.sql"), "SELECT 1"); // missing db header
    fs.writeFileSync(path.join(dir, "notes.txt"), "not sql, ignored");
    const { functions, problems } = loadDbFunctions(dir);
    assert.deepEqual(functions.map((f) => f.name), ["good"]);
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => p.file === "evil.sql"));
    assert.ok(problems.some((p) => p.file === "nope.sql"));
  });
  it("returns empty registries for a missing dir", () => {
    assert.deepEqual(loadDbFunctions(path.join(dir, "nope")), { functions: [], problems: [] });
    assert.deepEqual(loadDbCaches(path.join(dir, "nope")), { caches: [], problems: [] });
  });
});

describe("PersistenceCore EA17", () => {
  let dir: string;
  let contentDir: string;
  let core: PersistenceCore;
  let running = false;

  const seedDb = (): void => {
    const d = new Database(path.join(dir, "characters.db"));
    d.exec(`CREATE TABLE characters (id INTEGER PRIMARY KEY, username TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, look TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE deaths (id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL, at INTEGER NOT NULL, x REAL NOT NULL, z REAL NOT NULL, killer INTEGER);
      INSERT INTO characters (id, username, name, name_key, look, created_at) VALUES
        (1, 'u1', 'Alice', 'alice', '{}', 1000),
        (2, 'u2', 'Bob', 'bob', '{}', 2000),
        (3, 'u3', 'Cara', 'cara', '{}', 3000);
      INSERT INTO deaths (id, character_id, at, x, z, killer) VALUES
        (1, 2, 10, 0, 0, 1),
        (2, 3, 11, 0, 0, 1),
        (3, 1, 12, 0, 0, 2);`);
    d.close();
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbfn-core-"));
    contentDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbfn-content-"));
    fs.mkdirSync(path.join(contentDir, "db", "functions"), { recursive: true });
    fs.mkdirSync(path.join(contentDir, "db", "caches"), { recursive: true });
    fs.writeFileSync(path.join(contentDir, "db", "functions", "character_power.sql"), FN);
    fs.writeFileSync(
      path.join(contentDir, "db", "caches", "leaderboard.sql"),
      `-- db: characters
-- description: Top characters by net combat score.
SELECT c.name, COALESCE(k.kills, 0) - COALESCE(d.deaths, 0) AS power
FROM characters c
LEFT JOIN (SELECT killer AS id, COUNT(*) AS kills FROM deaths WHERE killer IS NOT NULL GROUP BY killer) k ON k.id = c.id
LEFT JOIN (SELECT character_id AS id, COUNT(*) AS deaths FROM deaths GROUP BY character_id) d ON d.id = c.id
ORDER BY power DESC, c.name ASC
LIMIT 100;
`,
    );
    seedDb();
    running = false;
    core = new PersistenceCore({ dataDir: dir, contentDir, isServerRunning: () => running });
  });
  afterEach(() => {
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(contentDir, { recursive: true, force: true });
  });

  const rejects = (p: Promise<unknown>, code: string): Promise<void> =>
    assert.rejects(p, (e) => e instanceof PersistenceError && e.code === code);

  it("lists functions with their params", () => {
    const { functions, problems } = core.listDbFunctions();
    assert.deepEqual(problems, []);
    assert.deepEqual(functions, [
      { name: "character_power", db: "characters", description: "Net combat score for one character.", params: ["character_id"] },
    ]);
  });

  it("runs a parameterized function read-only: Alice 2 kills - 1 death = 1", async () => {
    const r = await core.runDbFunction("character_power", { character_id: 1 });
    assert.deepEqual(r.columns, ["power"]);
    assert.deepEqual(r.rows, [[1]]);
    const bob = await core.runDbFunction("character_power", { character_id: 2 });
    assert.deepEqual(bob.rows, [[0]]); // 1 kill, 1 death
  });

  it("rejects a missing, unknown or mistyped parameter", async () => {
    await rejects(core.runDbFunction("character_power", {}), "bad-request");
    await rejects(core.runDbFunction("character_power", { character_id: 1, extra: 2 }), "bad-request");
    await rejects(core.runDbFunction("character_power", { character_id: true as never }), "bad-request");
    await rejects(core.runDbFunction("nope", {}), "bad-request");
  });

  it("a hostile function file never reaches execution (refused at load)", () => {
    fs.writeFileSync(path.join(contentDir, "db", "functions", "evil.sql"), "-- db: characters\nDELETE FROM characters;");
    const again = new PersistenceCore({ dataDir: dir, contentDir, isServerRunning: () => running });
    try {
      const { functions, problems } = again.listDbFunctions();
      assert.deepEqual(functions.map((f) => f.name), ["character_power"]);
      assert.ok(problems.some((p) => p.file === "evil.sql"));
    } finally {
      again.close();
    }
  });

  it("refresh builds the snapshot, records freshness, and re-refresh picks up new rows", async () => {
    assert.deepEqual(core.listDbCaches().caches.map((c) => [c.name, c.lastRefreshed]), [["leaderboard", null]]);
    const first = await core.refreshDbCache("leaderboard");
    assert.equal(first.rows, 3);
    assert.equal(first.db, "characters");
    const [listed] = core.listDbCaches().caches;
    assert.equal(typeof listed.lastRefreshed, "number");
    assert.equal(listed.rowCount, 3);
    const snap = await core.query("characters", "SELECT name, power FROM _cache_leaderboard");
    assert.deepEqual(snap.rows, [["Alice", 1], ["Bob", 0], ["Cara", -1]]);

    const d = new Database(path.join(dir, "characters.db"));
    d.exec("INSERT INTO deaths (id, character_id, at, x, z, killer) VALUES (4, 1, 20, 0, 0, 3)");
    d.close();
    const second = await core.refreshDbCache("leaderboard");
    assert.equal(second.rows, 3);
    assert.ok(second.refreshedAt >= first.refreshedAt);
    const snap2 = await core.query("characters", "SELECT name, power FROM _cache_leaderboard");
    assert.deepEqual(snap2.rows, [["Alice", 0], ["Bob", 0], ["Cara", 0]]);
  });

  it("refresh refuses while the server runs and for unknown caches", async () => {
    running = true;
    await rejects(core.refreshDbCache("leaderboard"), "refused");
    running = false;
    await rejects(core.refreshDbCache("nope"), "bad-request");
  });

  it("createDbFunction validates, stores and reloads", async () => {
    const created = await core.createDbFunction({
      name: "death_count",
      db: "characters",
      sql: "SELECT COUNT(*) AS deaths FROM deaths WHERE character_id = :character_id",
      description: "Recorded deaths for one character.",
    });
    assert.deepEqual(created.params, ["character_id"]);
    assert.ok(fs.existsSync(path.join(contentDir, "db", "functions", "death_count.sql")));
    assert.ok(core.listDbFunctions().functions.some((f) => f.name === "death_count"));
    const r = await core.runDbFunction("death_count", { character_id: 2 });
    assert.deepEqual(r.rows, [[1]]);
  });

  it("createDbFunction refuses duplicates, bad SQL and unknown databases", async () => {
    await rejects(core.createDbFunction({ name: "character_power", db: "characters", sql: "SELECT 1" }), "conflict");
    await rejects(core.createDbFunction({ name: "evil", db: "characters", sql: "DROP TABLE characters" }), "bad-request");
    await rejects(core.createDbFunction({ name: "x", db: "nosuchdb", sql: "SELECT 1" }), "bad-request");
    await rejects(core.createDbFunction({ name: "Bad Name", db: "characters", sql: "SELECT 1" }), "bad-request");
  });

  it("without a content dir the registries are empty and creation is refused", async () => {
    const bare = new PersistenceCore({ dataDir: dir });
    try {
      assert.deepEqual(bare.listDbFunctions(), { functions: [], problems: [] });
      assert.deepEqual(bare.listDbCaches(), { caches: [], problems: [] });
      await rejects(bare.createDbFunction({ name: "f", db: "characters", sql: "SELECT 1" }), "bad-request");
    } finally {
      bare.close();
    }
  });
});
