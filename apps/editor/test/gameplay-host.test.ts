/**
 * Gameplay grid storage (roadmap EA15): what a grid saves is what the
 * server's own loaders accept, a bad reference is refused with nothing
 * written, and removing something that scenes or quests use is refused.
 * Writes go to a throwaway repo root, never the real content.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadRules } from "@mmo-engine/rules";
import { checkGameplay, handleGameplay, readGameplay, saveGameplay } from "../src/gameplay-host.js";
import { editCell, removeRows } from "../src/gameplay-grid.js";
import { TABLE_DEFS, fromRows, toRows } from "../src/gameplay-tables.js";

const REPO = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));
const ROOT = join(tmpdir(), `mmo-gameplay-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const rulesFile = (name: string): string => join(ROOT, "content", "rules", `${name}.json`);
const disk = (name: string): string => readFileSync(rulesFile(name), "utf8");

before(() => {
  mkdirSync(join(ROOT, "packages"), { recursive: true });
  symlinkSync(join(REPO, "packages", "species"), join(ROOT, "packages", "species"), "junction");
});
beforeEach(() => {
  rmSync(join(ROOT, "content"), { recursive: true, force: true });
  cpSync(join(REPO, "content"), join(ROOT, "content"), { recursive: true });
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

describe("readGameplay", () => {
  it("returns every table as the files hold it, and what the references check against", async () => {
    const r = await readGameplay(ROOT);
    assert.ok((r.tables.creatures as Any).creatures.goblin);
    assert.ok((r.tables.items as Any).bases.sword);
    assert.ok(Array.isArray((r.tables.skills as Any).skills));
    assert.ok(r.context.refs.items.includes("sword"));
    assert.ok(r.context.refs.creatures.includes("goblin"));
    assert.deepEqual([...r.context.options.techniques].sort(), ["bludgeon", "cut", "thrust"]);
    assert.ok(r.context.options.families.includes("weapon"));
  });

  it("shows the built-in species roster merged with the game's overlay, and says which are built in", async () => {
    const r = await readGameplay(ROOT);
    const species = (r.tables.species as Any).species;
    assert.ok(species["void-watcher"]);
    assert.ok(r.context.builtinSpecies.includes("void-watcher"));
  });
});

describe("acceptance: edit a creature's health and drop, the server loads it", () => {
  it("saves through the grid model and loadRules reads the new numbers", async () => {
    const snap = await readGameplay(ROOT);
    let rows = toRows(TABLE_DEFS.creatures, snap.tables.creatures);
    rows = editCell(rows, "goblin", "health", 75);
    rows = editCell(rows, "goblin", "drops.chance", 0.25);
    rows = editCell(rows, "goblin", "drops.rolls", [0, 3]);
    await saveGameplay(ROOT, "creatures", fromRows(TABLE_DEFS.creatures, snap.tables.creatures, rows));
    const rules = loadRules(join(ROOT, "content", "rules"));
    assert.equal(rules.creatures.creatures.goblin.health, 75);
    assert.equal(rules.creatures.creatures.goblin.drops.chance, 0.25);
    assert.deepEqual(rules.creatures.creatures.goblin.drops.rolls, [0, 3]);
  });

  it("an item base, a skill and a spell edit load too", async () => {
    const snap = await readGameplay(ROOT);
    const items = editCell(toRows(TABLE_DEFS.items, snap.tables.items), "sword", "mass", 1.7);
    await saveGameplay(ROOT, "items", fromRows(TABLE_DEFS.items, snap.tables.items, items));
    const spells = editCell(toRows(TABLE_DEFS.spells, snap.tables.spells), "mend", "mana", 30);
    await saveGameplay(ROOT, "spells", fromRows(TABLE_DEFS.spells, snap.tables.spells, spells));
    const skills = editCell(toRows(TABLE_DEFS.skills, snap.tables.skills), "cutting", "name", "Slicing");
    await saveGameplay(ROOT, "skills", fromRows(TABLE_DEFS.skills, snap.tables.skills, skills));
    const rules = loadRules(join(ROOT, "content", "rules"));
    assert.equal(rules.items.bases.sword.mass, 1.7);
    assert.equal(rules.spells.spells[0].mana, 30);
    assert.equal(rules.skills.skills.find((s) => s.id === "cutting")?.name, "Slicing");
  });
});

describe("a bad save writes nothing", () => {
  it("a creature carrying an item base that doesn't exist is refused, with its field", async () => {
    const snap = await readGameplay(ROOT);
    const before = disk("creatures");
    const rows = editCell(toRows(TABLE_DEFS.creatures, snap.tables.creatures), "goblin", "weapons", ["spork"]);
    await assert.rejects(
      saveGameplay(ROOT, "creatures", fromRows(TABLE_DEFS.creatures, snap.tables.creatures, rows)),
      (e: Any) => e.status === 400 && e.issues.some((i: Any) => i.path === "creatures.goblin.weapons[0]" && /spork/.test(i.message)),
    );
    assert.equal(disk("creatures"), before);
  });

  it("a negative health is refused", async () => {
    const snap = await readGameplay(ROOT);
    const before = disk("creatures");
    const rows = editCell(toRows(TABLE_DEFS.creatures, snap.tables.creatures), "goblin", "health", -40);
    const issues = await checkGameplay(ROOT, "creatures", fromRows(TABLE_DEFS.creatures, snap.tables.creatures, rows));
    assert.ok(issues.some((i) => i.path === "creatures.goblin.health"));
    assert.equal(disk("creatures"), before);
  });

  it("removing an item base a creature carries is refused", async () => {
    const snap = await readGameplay(ROOT);
    const before = disk("items");
    const rows = removeRows(toRows(TABLE_DEFS.items, snap.tables.items), ["axe"]);
    await assert.rejects(saveGameplay(ROOT, "items", fromRows(TABLE_DEFS.items, snap.tables.items, rows)), (e: Any) => e.status === 400);
    assert.equal(disk("items"), before);
  });

  it("removing a creature a quest or a scene uses is refused, naming where", async () => {
    const snap = await readGameplay(ROOT);
    const before = disk("creatures");
    const rows = removeRows(toRows(TABLE_DEFS.creatures, snap.tables.creatures), ["goblin"]);
    await assert.rejects(
      saveGameplay(ROOT, "creatures", fromRows(TABLE_DEFS.creatures, snap.tables.creatures, rows)),
      (e: Any) =>
        e.status === 400 &&
        e.issues.some((i: Any) => /quests\.json/.test(i.message)) &&
        e.issues.some((i: Any) => /test-arena\.scene\.json/.test(i.message)),
    );
    assert.equal(disk("creatures"), before);
  });

  it("removing an item a quest rewards or asks for is refused", async () => {
    const snap = await readGameplay(ROOT);
    const rows = removeRows(toRows(TABLE_DEFS.items, snap.tables.items), ["amulet", "sword"]);
    const issues = await checkGameplay(ROOT, "items", fromRows(TABLE_DEFS.items, snap.tables.items, rows));
    assert.ok(issues.some((i) => /quests\.json/.test(i.message) && /sword/.test(i.path + i.message)));
  });

  it("a skill in an unknown family is refused", async () => {
    const snap = await readGameplay(ROOT);
    const rows = editCell(toRows(TABLE_DEFS.skills, snap.tables.skills), "cutting", "family", "nonsense");
    const issues = await checkGameplay(ROOT, "skills", fromRows(TABLE_DEFS.skills, snap.tables.skills, rows));
    assert.ok(issues.some((i) => i.path === "skills[0].family"));
  });
});

describe("species", () => {
  it("writes only what differs from the built-in roster, and loadSpecies reads it", async () => {
    const snap = await readGameplay(ROOT);
    const rows = toRows(TABLE_DEFS.species, snap.tables.species);
    const edited = editCell(rows, "void-watcher", "minRank", 4);
    await saveGameplay(ROOT, "species", fromRows(TABLE_DEFS.species, snap.tables.species, edited));
    const file = join(ROOT, "content", "species", "species.json");
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(written), ["void-watcher"]);
    const { loadSpecies } = (await import(pathToFileURL(join(REPO, "packages", "species", "dist", "src", "index.js")).href)) as { loadSpecies(f: string): Record<string, { minRank: number }> };
    assert.equal(loadSpecies(file)["void-watcher"].minRank, 4);
  });

  it("a bad species is refused and no overlay is written", async () => {
    const snap = await readGameplay(ROOT);
    const file = join(ROOT, "content", "species", "species.json");
    const was = existsSync(file) ? readFileSync(file, "utf8") : null; // the test above may have written an overlay
    const rows = editCell(toRows(TABLE_DEFS.species, snap.tables.species), "void-watcher", "pack", [3, 1]);
    await assert.rejects(saveGameplay(ROOT, "species", fromRows(TABLE_DEFS.species, snap.tables.species, rows)), (e: Any) => e.status === 400 && e.issues.some((i: Any) => /void-watcher/.test(i.path)));
    assert.equal(existsSync(file) ? readFileSync(file, "utf8") : null, was);
  });
});

describe("handleGameplay", () => {
  it("serves the snapshot, checks without writing, saves, and refuses what it doesn't know", async () => {
    const get = await handleGameplay(ROOT, { method: "GET", route: "", contentType: undefined, body: {} });
    assert.equal(get.status, 200);
    const creatures = (get.body as Any).tables.creatures;
    const bad = { ...creatures, creatures: { goblin: { ...creatures.creatures.goblin, health: -1 } } };
    const before = disk("creatures");
    const check = await handleGameplay(ROOT, { method: "POST", route: "check", contentType: "application/json", body: { table: "creatures", content: bad } });
    assert.equal(check.status, 200);
    assert.equal((check.body as Any).issues.length > 0, true);
    const refused = await handleGameplay(ROOT, { method: "PUT", route: "creatures", contentType: "application/json", body: { content: bad } });
    assert.equal(refused.status, 400);
    assert.equal(disk("creatures"), before);
    const good = { ...creatures, creatures: { goblin: { ...creatures.creatures.goblin, health: 61 } } };
    const saved = await handleGameplay(ROOT, { method: "PUT", route: "creatures", contentType: "application/json", body: { content: good } });
    assert.equal(saved.status, 200);
    assert.equal(loadRules(join(ROOT, "content", "rules")).creatures.creatures.goblin.health, 61);
    assert.equal((await handleGameplay(ROOT, { method: "PUT", route: "../x", contentType: "application/json", body: { content: {} } })).status, 404);
    assert.equal((await handleGameplay(ROOT, { method: "PUT", route: "creatures", contentType: "text/plain", body: { content: good } })).status, 415);
  });
});

describe("gameplay routes", () => {
  it("answers only its own paths, refuses bad JSON, serves the catalog", async () => {
    const { handleGameplayRoute } = await import("../src/gameplay-routes.js");
    const body = async (): Promise<string> => "{";
    assert.equal(await handleGameplayRoute(ROOT, "GET", "/api/editor/rules", undefined, body), null);
    assert.equal((await handleGameplayRoute(ROOT, "GET", "/api/editor/gameplay", undefined, body))?.status, 200);
    assert.equal((await handleGameplayRoute(ROOT, "PUT", "/api/editor/gameplay/creatures", "application/json", body))?.status, 400);
    assert.equal((await handleGameplayRoute(ROOT, "GET", "/api/editor/content-catalog", undefined, body))?.status, 200);
  });
});
