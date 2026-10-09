import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCell, rowKey, stage, toMutations, viewRows, type Column, type Table } from "../src/database-model.js";
import { ADMIN, handleDatabase, type DatabaseCore } from "../src/database-host.js";

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({ name, type, notNull: false, pk: 0, editable: true, ...extra });

describe("parseCell", () => {
  it("validates per declared type", () => {
    assert.deepEqual(parseCell(col("a", "INTEGER"), "12"), { value: 12 });
    assert.ok("error" in parseCell(col("a", "INTEGER"), "1.5"));
    assert.ok("error" in parseCell(col("a", "REAL"), "abc"));
    assert.deepEqual(parseCell(col("a", "REAL"), "2.5"), { value: 2.5 });
    assert.deepEqual(parseCell(col("a", "TEXT"), "hi"), { value: "hi" });
  });
  it("empty is null only when the column allows it", () => {
    assert.deepEqual(parseCell(col("a", "REAL"), ""), { value: null });
    assert.ok("error" in parseCell(col("a", "REAL", { notNull: true }), ""));
  });
});

describe("viewRows", () => {
  const cols = ["id", "name"];
  const rows = [[2, "bob"], [1, "alice"], [3, null]];
  it("searches any cell", () => assert.deepEqual(viewRows(rows, cols, "ALI", null), [[1, "alice"]]));
  it("sorts numbers numerically, nulls last", () => {
    assert.deepEqual(viewRows(rows, cols, "", { column: "id", dir: "desc" }).map((r) => r[0]), [3, 2, 1]);
    assert.deepEqual(viewRows(rows, cols, "", { column: "name", dir: "asc" }).map((r) => r[0]), [1, 2, 3]);
  });
});

describe("pending edits", () => {
  const table: Table = { name: "t", rowCount: 1, editable: true, columns: [col("id", "INTEGER", { pk: 1, editable: false }), col("hp", "REAL"), col("name", "TEXT")] };
  it("groups by row, replaces a cell, and drops a restored one", () => {
    const key = rowKey(table, ["id", "hp", "name"], [7, 50, "x"]);
    assert.deepEqual(key, { id: 7 });
    let p = stage([], { key, column: "hp", value: 60 }, 50);
    p = stage(p, { key, column: "name", value: "y" }, "x");
    p = stage(p, { key, column: "hp", value: 70 }, 50);
    assert.deepEqual(toMutations("characters", "t", p), [{ db: "characters", table: "t", key: { id: 7 }, set: { hp: 70, name: "y" } }]);
    assert.equal(stage(p, { key, column: "hp", value: 50 }, 50).length, 1);
  });
});

describe("database host routes", () => {
  const calls: string[] = [];
  let running = false;
  const core: DatabaseCore = {
    catalog: () => [],
    query: async (_d, sql) => {
      if (!/^select/i.test(sql)) throw Object.assign(new Error("only SELECT queries are allowed"), { code: "refused" });
      return { rows: [] };
    },
    apply: async (a) => (calls.push(`apply:${a}`), []),
    log: () => [],
    undo: async (a, id) => (calls.push(`undo:${a}:${id}`), {}),
  };
  const deps = { core, serverRunning: async () => running };
  const post = (route: string, body: unknown, contentType = "application/json") => handleDatabase(deps, { method: "POST", route, body, contentType });

  it("refuses a non-SELECT query with 403", async () => assert.equal((await post("query", { db: "x", sql: "DELETE FROM t" })).status, 403));
  it("answers a SELECT", async () => assert.equal((await post("query", { db: "x", sql: "SELECT 1" })).status, 200));
  it("demands a JSON content type on POST", async () => assert.equal((await post("apply", { mutations: [] }, "text/plain")).status, 415));
  it("applies as the editor admin and refuses while the server runs", async () => {
    assert.equal((await post("apply", { mutations: [] })).status, 200);
    assert.deepEqual(calls, [`apply:${ADMIN}`]);
    running = true;
    assert.equal((await post("apply", { mutations: [] })).status, 409);
    assert.equal((await post("undo", { id: 1 })).status, 409);
    running = false;
    assert.equal((await post("undo", { id: 1 })).status, 200);
  });
  it("rejects malformed bodies and unknown routes", async () => {
    assert.equal((await post("query", {})).status, 400);
    assert.equal((await post("nope", {})).status, 404);
  });
});
