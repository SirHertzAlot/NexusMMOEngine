/**
 * The gameplay tables (ED1): reads the editable rules files, saves only
 * what the server would load, and writes nothing on a refused save.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isEditableTable, readRulesTables, saveRulesTable } from "../src/rules-store.js";

// dist/test/ -> repo root
const RULES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../content/rules");

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ed1-rules-"));
  for (const f of fs.readdirSync(RULES)) if (f.endsWith(".json")) fs.copyFileSync(path.join(RULES, f), path.join(dir, f));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));

describe("readRulesTables", () => {
  it("returns the editable tables as written, and combat's techniques", () => {
    const { tables, techniques } = readRulesTables(dir);
    assert.deepEqual(tables.loot, read("loot"));
    assert.ok((tables.items as { bases: Record<string, unknown> }).bases.sword);
    assert.ok((tables.creatures as { creatures: Record<string, unknown> }).creatures.goblin);
    assert.deepEqual(techniques.sort(), ["bludgeon", "cut", "thrust"]);
  });

  it("an absent file reads as {} (the engine defaults)", () => {
    fs.rmSync(path.join(dir, "death.json"));
    assert.deepEqual(readRulesTables(dir).tables.death, {});
  });
});

describe("saveRulesTable", () => {
  it("writes a valid table as two-space JSON", () => {
    const loot = { ...(read("loot") as object), despawnSeconds: 120 };
    assert.deepEqual(saveRulesTable(dir, "loot", loot), { ok: true });
    const text = fs.readFileSync(path.join(dir, "loot.json"), "utf8");
    assert.equal(text, `${JSON.stringify(loot, null, 2)}\n`);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  });

  it("refuses a schema failure with its field, writing nothing", () => {
    const before = fs.readFileSync(path.join(dir, "loot.json"), "utf8");
    const res = saveRulesTable(dir, "loot", { ...(read("loot") as object), pickupRange: -1 });
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.issues.some((i) => i.file === "loot.json" && i.path === "pickupRange"));
    assert.equal(fs.readFileSync(path.join(dir, "loot.json"), "utf8"), before);
  });

  it("refuses what only the cross-file checks catch", () => {
    const creatures = read("creatures") as { creatures: Record<string, { weapons: string[]; leashRadius: number }> };
    creatures.creatures.goblin.weapons = ["nosuchbase"];
    const res = saveRulesTable(dir, "creatures", creatures);
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.issues.some((i) => i.file === "creatures.json" && /nosuchbase/.test(i.message)));
  });

  it("refuses an item base with an unknown technique", () => {
    const items = read("items") as { bases: Record<string, { technique: string }> };
    items.bases.sword.technique = "tickle";
    const res = saveRulesTable(dir, "items", items);
    assert.ok(!res.ok && res.issues.some((i) => i.file === "items.json"));
  });
});

describe("isEditableTable", () => {
  it("allows only the editor's tables", () => {
    for (const t of ["items", "creatures", "loot", "death", "ingress", "gathering"]) assert.equal(isEditableTable(t), true, t);
    for (const t of ["combat", "body", "../loot", "", 3, undefined]) assert.equal(isEditableTable(t), false, String(t));
  });
});
