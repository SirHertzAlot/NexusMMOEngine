/**
 * The data-driven grids (loot tables, crafting recipes, prefabs): what a grid
 * saves is what the game's own loaders read, a bad cell is refused with its
 * path and nothing written, and the server's scene spawner instantiates a
 * prefab the editor wrote. Writes go to a throwaway repo root.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadRules } from "@mmo-engine/rules";
import { checkGameplay, readGameplay, saveGameplay } from "../src/gameplay-host.js";
import { checkCell, editCell, removeRows } from "../src/gameplay-grid.js";
import { TABLE_DEFS, fromRows, toRows } from "../src/gameplay-tables.js";
import { buildCatalog } from "../src/content-catalog.js";
import { prettyJson, readPrefabs } from "../src/data-host.js";

const REPO = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));
const ROOT = join(tmpdir(), `mmo-data-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");
const json = (...p: string[]): Any => JSON.parse(read(...p));

before(() => {
  mkdirSync(join(ROOT, "packages"), { recursive: true });
  for (const p of ["species", "crafting"]) symlinkSync(join(REPO, "packages", p), join(ROOT, "packages", p), "junction");
});
beforeEach(() => {
  rmSync(join(ROOT, "content"), { recursive: true, force: true });
  cpSync(join(REPO, "content"), join(ROOT, "content"), { recursive: true });
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

const edit = async (table: Any, fn: (rows: ReturnType<typeof toRows>) => ReturnType<typeof toRows>): Promise<void> => {
  const snap = await readGameplay(ROOT);
  const def = TABLE_DEFS[table as keyof typeof TABLE_DEFS];
  await saveGameplay(ROOT, table, fromRows(def, snap.tables[table as keyof typeof snap.tables], fn(toRows(def, snap.tables[table as keyof typeof snap.tables]))));
};

describe("the snapshot", () => {
  it("carries loot tables, crafting sections and prefabs, and what references check against", async () => {
    const r = await readGameplay(ROOT);
    assert.ok((r.tables.loot as Any).tables["goblin-spoils"]);
    assert.ok((r.tables.refining as Any).refining.steel.inputs);
    assert.ok((r.tables.reagents as Any).reagents.fire);
    assert.deepEqual((r.tables.prefabs as Any).prefabs, {});
    assert.ok(r.context.refs.materials.includes("iron-ore"));
    assert.ok(r.context.options.lootTables.includes("goblin-spoils"));
    assert.ok(r.context.options.nodeKinds.includes("group"));
  });
});

describe("loot tables", () => {
  it("a creature's named drops edited in the grids are what the server's rules loader reads", async () => {
    await edit("loot", (rows) => editCell(rows, "goblin-spoils", "entries", [{ base: "sword", chance: 0.9, count: [1, 2] }]));
    await edit("creatures", (rows) => editCell(rows, "goblin", "drops.rolls", [0, 0]));
    const rules = loadRules(join(ROOT, "content", "rules"));
    assert.deepEqual(rules.loot.tables!["goblin-spoils"].entries, [{ base: "sword", chance: 0.9, count: [1, 2] }]);
    assert.deepEqual(rules.creatures.creatures.goblin.drops.rolls, [0, 0]);
    assert.equal(rules.loot.ownershipSeconds, 30, "the rest of loot.json survives");
  });

  it("a new table and a creature pointed at it save together once the table exists", async () => {
    await edit("loot", (rows) => [...rows, { id: "wolf-pelts", data: { entries: [{ base: "dagger", chance: 1, count: [1, 1] }] } }]);
    await edit("creatures", (rows) => editCell(rows, "goblin", "drops.table", "wolf-pelts"));
    assert.equal(loadRules(join(ROOT, "content", "rules")).creatures.creatures.goblin.drops.table, "wolf-pelts");
  });

  it("an unknown base, or a table a creature still names, is refused with its path and nothing written", async () => {
    const before = read("content", "rules", "loot.json");
    const snap = await readGameplay(ROOT);
    const bad = editCell(toRows(TABLE_DEFS.loot, snap.tables.loot), "goblin-spoils", "entries", [{ base: "spork", chance: 1 }]);
    await assert.rejects(
      saveGameplay(ROOT, "loot", fromRows(TABLE_DEFS.loot, snap.tables.loot, bad)),
      (e: Any) => e.status === 400 && e.issues.some((i: Any) => i.path === "tables.goblin-spoils.entries[0].base" && /spork/.test(i.message)),
    );
    const gone = removeRows(toRows(TABLE_DEFS.loot, snap.tables.loot), ["goblin-spoils"]);
    const issues = await checkGameplay(ROOT, "loot", fromRows(TABLE_DEFS.loot, snap.tables.loot, gone));
    assert.ok(issues.some((i) => /no loot table "goblin-spoils"/.test(i.message)), "the creature that names it keeps it");
    assert.equal(read("content", "rules", "loot.json"), before);
  });

  it("the cell check answers while typing", async () => {
    const snap = await readGameplay(ROOT);
    const ctx = { refs: snap.context.refs, options: snap.context.options };
    const col = TABLE_DEFS.loot.columns[0];
    assert.equal(checkCell(col, [{ base: "dagger", chance: 0.5, count: [1, 2] }], ctx), null);
    assert.match(checkCell(col, [{ base: "spork" }], ctx)!, /no item base "spork"/);
    assert.match(checkCell(col, [{ base: "dagger", chance: 2 }], ctx)!, /between 0 and 1/);
    assert.match(checkCell(col, [{ base: "dagger", count: [3, 1] }], ctx)!, /min is above max/);
    assert.match(checkCell(col, [], ctx)!, /at least one line/);
  });
});

describe("crafting recipes", () => {
  it("a refining edit lands in content/crafting/recipes.json, the file the server and craft:report read", async () => {
    await edit("refining", (rows) => editCell(rows, "steel", "inputs", { "iron-ore": 3, coal: 3 }));
    const file = json("content", "crafting", "recipes.json");
    assert.deepEqual(file.refining.steel.inputs, { "iron-ore": 3, coal: 3 });
    assert.deepEqual(file.reagents.fire, { reagent: "fire-crystal", extra: "demon-ichor" }, "the other sections stay");
    assert.match(read("content", "crafting", "recipes.json"), /"iron": \{ "inputs": \{ "iron-ore": 2, "coal": 1 \} \}/, "short values stay on one line");
    const crafting = (await import(pathToFileURL(join(REPO, "packages", "crafting", "dist", "src", "index.js")).href)) as Any;
    const rules = crafting.loadCraftingRules(join(ROOT, "content", "crafting", "recipes.json"));
    assert.ok(rules, "the sample recipes file loads");
    assert.equal(rules.refining.steel.inputs.coal, 3);
  });

  it("saving one section never undoes the other", async () => {
    const stale = await readGameplay(ROOT);
    await edit("refining", (rows) => editCell(rows, "steel", "inputs", { "iron-ore": 5 }));
    // The reagents grid still holds the file as it was before the refining save.
    const rows = editCell(toRows(TABLE_DEFS.reagents, stale.tables.reagents), "frost", "reagent", "silver-ore");
    await saveGameplay(ROOT, "reagents", fromRows(TABLE_DEFS.reagents, stale.tables.reagents, rows));
    const file = json("content", "crafting", "recipes.json");
    assert.deepEqual(file.refining.steel.inputs, { "iron-ore": 5 });
    assert.equal(file.reagents.frost.reagent, "silver-ore");
  });

  it("an unknown raw material, or a missing composer material, is refused with its path and nothing written", async () => {
    const before = read("content", "crafting", "recipes.json");
    const snap = await readGameplay(ROOT);
    const bad = editCell(toRows(TABLE_DEFS.refining, snap.tables.refining), "steel", "inputs", { unobtainium: 1 });
    await assert.rejects(
      saveGameplay(ROOT, "refining", fromRows(TABLE_DEFS.refining, snap.tables.refining, bad)),
      (e: Any) => e.status === 400 && e.issues.some((i: Any) => i.path === "refining.steel.inputs.unobtainium"),
    );
    const gone = removeRows(toRows(TABLE_DEFS.refining, snap.tables.refining), ["iron"]);
    const issues = await checkGameplay(ROOT, "refining", fromRows(TABLE_DEFS.refining, snap.tables.refining, gone));
    assert.ok(issues.some((i) => /composer material "iron" has no refining recipe/.test(i.message)));
    assert.equal(read("content", "crafting", "recipes.json"), before);
  });

  it("the cell check knows the raw materials", async () => {
    const snap = await readGameplay(ROOT);
    const ctx = { refs: snap.context.refs, options: snap.context.options };
    const col = TABLE_DEFS.refining.columns[0];
    assert.equal(checkCell(col, { "iron-ore": 2 }, ctx), null);
    assert.match(checkCell(col, { wibble: 2 }, ctx)!, /not a known raw material/);
    assert.match(checkCell(col, { coal: 0 }, ctx)!, /whole number/);
  });
});

describe("prefabs", () => {
  const camp = { kind: "group", components: { Spawner: { creature: "goblin", respawnSeconds: 90 } }, children: [{ id: "lookout", transform: { position: [6, 0, 2] }, components: { Spawner: { creature: "goblin" } } }] };

  it("a prefab added in the grid is written as a file and read back whole", async () => {
    await edit("prefabs", (rows) => [...rows, { id: "goblin-camp", data: camp }]);
    const file = json("content", "prefabs", "goblin-camp.prefab.json");
    assert.deepEqual(file, { version: 1, name: "goblin-camp", ...camp });
    assert.deepEqual(Object.keys(readPrefabs(ROOT)), ["goblin-camp"]);
    const snap = await readGameplay(ROOT);
    assert.deepEqual((snap.tables.prefabs as Any).prefabs["goblin-camp"], camp);
    assert.ok(snap.context.refs.prefabs.includes("goblin-camp"));
  });

  it("the server's scene spawner instantiates it where a scene places it", async () => {
    await edit("prefabs", (rows) => [...rows, { id: "goblin-camp", data: camp }]);
    const sceneSpawn = (await import(pathToFileURL(join(REPO, "packages", "engine-core", "dist", "src", "scene-spawn.js")).href)) as Any;
    const prefabs = sceneSpawn.loadPrefabs(join(ROOT, "content", "prefabs"));
    assert.deepEqual(Object.keys(prefabs), ["goblin-camp"]);
    const scene = { version: 1, name: "t", kind: "arena", nodes: [{ id: "c", prefab: "goblin-camp", transform: { position: [50, 0, 50] }, components: { Spawner: { respawnSeconds: 10 } } }] };
    const { expandPrefabs } = (await import("@mmo-engine/scene")) as Any;
    const out = expandPrefabs(scene, prefabs).doc;
    assert.deepEqual(out.nodes[0].components.Spawner, { creature: "goblin", respawnSeconds: 10 });
    assert.equal(out.nodes[0].children[0].id, "c.lookout");
  });

  it("a bad component, a loop, a creature's name and an unused delete are judged by the game's rules", async () => {
    const snap = await readGameplay(ROOT);
    const rows = toRows(TABLE_DEFS.prefabs, snap.tables.prefabs);
    const put = (id: string, data: Any) => fromRows(TABLE_DEFS.prefabs, snap.tables.prefabs, [...rows, { id, data }]);
    const bad = await checkGameplay(ROOT, "prefabs", put("oops", { components: { Nope: {} } }));
    assert.ok(bad.some((i) => i.path === "prefabs.oops.components.Nope" && /unknown component/.test(i.message)));
    const loop = await checkGameplay(ROOT, "prefabs", put("again", { children: [{ id: "x", prefab: "again" }] }));
    assert.ok(loop.some((i) => /places itself/.test(i.message)));
    const creature = await checkGameplay(ROOT, "prefabs", put("goblin", { components: {} }));
    assert.ok(creature.some((i) => /is a creature/.test(i.message)));
    assert.deepEqual(await checkGameplay(ROOT, "prefabs", put("fine", camp)), []);
    assert.equal(existsSync(join(ROOT, "content", "prefabs", "oops.prefab.json")), false, "checks write nothing");
  });

  it("a prefab a scene places can't be removed; an unused one can, and its file goes", async () => {
    await edit("prefabs", (rows) => [...rows, { id: "goblin-camp", data: camp }, { id: "spare", data: { kind: "group" } }]);
    const scene = json("content", "scenes", "test-arena.scene.json");
    scene.nodes.push({ id: "camp-2", prefab: "camps/goblin-camp", transform: { position: [1, 0, 1] } });
    writeFileSync(join(ROOT, "content", "scenes", "test-arena.scene.json"), JSON.stringify(scene));
    const snap = await readGameplay(ROOT);
    const rows = toRows(TABLE_DEFS.prefabs, snap.tables.prefabs);
    await assert.rejects(
      saveGameplay(ROOT, "prefabs", fromRows(TABLE_DEFS.prefabs, snap.tables.prefabs, removeRows(rows, ["goblin-camp"]))),
      (e: Any) => e.status === 400 && e.issues.some((i: Any) => /test-arena\.scene\.json still place it/.test(i.message)),
    );
    assert.ok(existsSync(join(ROOT, "content", "prefabs", "goblin-camp.prefab.json")));
    await saveGameplay(ROOT, "prefabs", fromRows(TABLE_DEFS.prefabs, snap.tables.prefabs, removeRows(rows, ["spare"])));
    assert.equal(existsSync(join(ROOT, "content", "prefabs", "spare.prefab.json")), false);
  });

  it("removing a creature a prefab spawns is refused, naming the prefab", async () => {
    await edit("prefabs", (rows) => [...rows, { id: "goblin-camp", data: camp }]);
    const snap = await readGameplay(ROOT);
    // The scene and quests already hold the goblin; the prefab is one more reason.
    const rows = removeRows(toRows(TABLE_DEFS.creatures, snap.tables.creatures), ["goblin"]);
    const issues = await checkGameplay(ROOT, "creatures", fromRows(TABLE_DEFS.creatures, snap.tables.creatures, rows));
    assert.ok(issues.some((i) => /goblin-camp\.prefab\.json/.test(i.message)));
  });
});

describe("the placeables catalog", () => {
  it("lists prefab files and gives items, species, quests and PICG assets a scene node to drop", async () => {
    await edit("prefabs", (rows) => [...rows, { id: "goblin-camp", data: { kind: "group" } }]);
    const cat = await buildCatalog(ROOT);
    const node = (kind: string, id: string): Any => cat.entries.find((e) => e.kind === kind && e.id === id)?.node;
    assert.deepEqual(node("item", "sword").components, { ItemSpawn: { base: "sword" } });
    assert.deepEqual(node("species", "wolf").components, { Spawner: { species: "wolf" } });
    assert.deepEqual(node("quest", "goblin-trouble").components, { QuestGiver: { quest: "goblin-trouble" } });
    assert.equal(node("picg", "oak").prefab, "oak");
    assert.equal(node("prefab", "goblin-camp").prefab, "goblin-camp");
    assert.ok(cat.entries.find((e) => e.kind === "prefab" && e.id === "goblin-camp")!.detail.includes("prefab file"));
    for (const e of cat.entries.filter((x) => ["item", "species", "quest", "picg", "prefab", "creature"].includes(x.kind))) assert.ok(e.node, `${e.kind} ${e.id} is placeable`);
    assert.ok(!cat.notes.some((n) => /no prefab file format/.test(n)));
  });
});

describe("prettyJson", () => {
  it("spreads the top level and keeps short values on one line", () => {
    assert.equal(prettyJson({ a: { b: [1, 2] }, c: "x" }), '{\n  "a": { "b": [1, 2] },\n  "c": "x"\n}');
    assert.deepEqual(JSON.parse(prettyJson({ list: [{ id: "a", n: 1 }, { id: "b", n: [1, 2, 3] }], e: {} })), { list: [{ id: "a", n: 1 }, { id: "b", n: [1, 2, 3] }], e: {} });
  });
});
