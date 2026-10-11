/** The Gameplay data grids' pure model (EA15): parse, per-cell validation, search/filter/sort, batch actions. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addRow, batchScale, batchSet, checkCell, duplicateRow, editCell, parseCell, removeRows, viewRows, type GridColumn, type GridRow } from "../src/gameplay-grid.js";
import { TABLE_DEFS, cellOfIssue, fromRows, toRows } from "../src/gameplay-tables.js";

const col = (key: string): GridColumn => {
  const c = TABLE_DEFS.creatures.columns.find((x) => x.key === key);
  assert.ok(c, key);
  return c;
};
const ctx = { refs: { items: ["sword", "axe"] }, options: { techniques: ["cut"] } };
const rows: GridRow[] = [
  { id: "goblin", data: { name: "Goblin", health: 60, pack: [2, 4], weapons: ["axe"], drops: { rolls: [1, 2], chance: 0.8 } } },
  { id: "ogre", data: { name: "Ogre", health: 480, pack: [1, 1], weapons: ["sword"] } },
  { id: "wolf", data: { name: "Wolf", health: 40, pack: [3, 5], weapons: ["axe"] } },
];

describe("cells", () => {
  it("parses text into the column's kind, and reports the unparseable", () => {
    assert.deepEqual(parseCell(col("health"), "55"), { value: 55 });
    assert.deepEqual(parseCell(col("pack"), "2-4"), { value: [2, 4] });
    assert.deepEqual(parseCell(col("weapons"), "axe, sword"), { value: ["axe", "sword"] });
    assert.deepEqual(parseCell(col("health"), ""), { value: undefined });
    assert.ok("error" in parseCell(col("health"), "lots"));
    const json = TABLE_DEFS.spells.columns.find((c) => c.key === "effect")!;
    assert.deepEqual(parseCell(json, '{"kind":"heal","amount":3}'), { value: { kind: "heal", amount: 3 } });
    assert.ok("error" in parseCell(json, "{nope"));
  });

  it("checks a value against range, enum and references before it is saved", () => {
    assert.equal(checkCell(col("health"), 60, ctx), null);
    assert.match(checkCell(col("health"), -40, ctx) ?? "", /at least 0/);
    assert.match(checkCell(col("weapons"), ["axe", "spork"], ctx) ?? "", /no items "spork"/);
    assert.match(checkCell(col("pack"), [4, 2], ctx) ?? "", /min is above max/);
    const tech = TABLE_DEFS.items.columns.find((c) => c.key === "technique")!;
    assert.match(checkCell(tech, "zap", ctx) ?? "", /one of cut/);
    assert.equal(checkCell(tech, "cut", ctx), null);
  });
});

describe("view", () => {
  it("searches ids and text, filters a column, sorts either way", () => {
    assert.deepEqual(viewRows(rows, { search: "OG" }).map((r) => r.id), ["ogre"]);
    assert.deepEqual(viewRows(rows, { filters: { weapons: "axe" } }).map((r) => r.id), ["goblin", "wolf"]);
    assert.deepEqual(viewRows(rows, { sort: { key: "health", dir: "desc" } }).map((r) => r.id), ["ogre", "goblin", "wolf"]);
    assert.deepEqual(viewRows(rows, { sort: { key: "health", dir: "asc" } }).map((r) => r.id), ["wolf", "goblin", "ogre"]);
    assert.deepEqual(rows.map((r) => r.id), ["goblin", "ogre", "wolf"]);
  });
});

describe("edits", () => {
  it("edits one cell (nested keys too) without touching the input", () => {
    const a = editCell(rows, "goblin", "drops.chance", 0.5);
    assert.deepEqual((a[0].data as { drops: unknown }).drops, { rolls: [1, 2], chance: 0.5 });
    assert.equal((rows[0].data as { drops: { chance: number } }).drops.chance, 0.8);
    assert.equal((editCell(rows, "ogre", "health", undefined)[1].data as { health?: number }).health, undefined);
  });

  it("batch-sets, batch-scales (whole numbers stay whole), removes, duplicates and adds", () => {
    assert.deepEqual(batchSet(rows, ["goblin", "wolf"], "respawnSeconds", 30).map((r) => (r.data as { respawnSeconds?: number }).respawnSeconds), [30, undefined, 30]);
    const scaled = batchScale(rows, ["goblin", "ogre"], col("health"), 1.5);
    assert.deepEqual(scaled.map((r) => (r.data as { health: number }).health), [90, 720, 40]);
    assert.equal((batchScale(rows, ["wolf"], { kind: "number", key: "health", label: "Health", int: true }, 0.33)[2].data as { health: number }).health, 13);
    assert.deepEqual(removeRows(rows, ["ogre"]).map((r) => r.id), ["goblin", "wolf"]);
    const d = duplicateRow(rows, "goblin");
    assert.equal(d.length, 4);
    assert.equal(d[1].id, "goblin-2");
    assert.notEqual(d[1].data, rows[0].data);
    assert.throws(() => addRow(rows, "wolf", {}), /already/);
    assert.equal(addRow(rows, "bat", { name: "Bat" }).length, 4);
  });
});

describe("table definitions", () => {
  it("round-trips a rules file, keeping what the grid doesn't show", () => {
    const json = { creatures: { goblin: { name: "Goblin", health: 60 } }, extra: 1 };
    const r = toRows(TABLE_DEFS.creatures, json);
    assert.deepEqual(r.map((x) => x.id), ["goblin"]);
    assert.deepEqual(fromRows(TABLE_DEFS.creatures, json, editCell(r, "goblin", "health", 70)), { creatures: { goblin: { name: "Goblin", health: 70 } }, extra: 1 });
    const sp = { max: 100, spells: [{ id: "mend", name: "Mend" }] };
    const sr = toRows(TABLE_DEFS.spells, sp);
    assert.deepEqual(sr.map((x) => x.id), ["mend"]);
    assert.deepEqual(fromRows(TABLE_DEFS.spells, sp, sr), sp);
  });

  it("maps a server issue path to its row and column", () => {
    assert.deepEqual(cellOfIssue(TABLE_DEFS.creatures, "creatures.goblin.weapons[0]", []), { rowId: "goblin", key: "weapons" });
    assert.deepEqual(cellOfIssue(TABLE_DEFS.creatures, "creatures.goblin.drops.chance", []), { rowId: "goblin", key: "drops.chance" });
    const sr = toRows(TABLE_DEFS.skills, { skills: [{ id: "a" }, { id: "b" }] });
    assert.deepEqual(cellOfIssue(TABLE_DEFS.skills, "skills[1].family", sr), { rowId: "b", key: "family" });
    assert.equal(cellOfIssue(TABLE_DEFS.skills, "max", sr), null);
  });
});
