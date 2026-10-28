import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applySavedView,
  buildHierarchy,
  deserializeSavedView,
  filterByRole,
  makeFacts,
  serializeSavedView,
  sortNodes,
  type SceneNodeData,
  type SavedView,
} from "../src/authoring/index.js";

const data: SceneNodeData[] = [
  { id: "haven", name: "Haven", level: "scene", parentId: null },
  { id: "market", name: "Market Square", level: "region", parentId: "haven" },
  { id: "fountain-poi", name: "Fountain", level: "poi", parentId: "market" },
  {
    id: "npc-mara",
    name: "Blacksmith Mara",
    level: "object",
    parentId: "fountain-poi",
    kind: "npc",
    modifiedAt: 300,
    facts: makeFacts({ id: "npc-mara", label: "Blacksmith Mara", kind: "npc", components: ["Transform", "CharacterRef"], isVendor: true, vendorTemplateId: "weapons-tier2", isQuestGiver: true }),
    references: { templateId: "weapons-tier2", dialogueGraphId: "mara-dialogue" },
  },
  {
    id: "npc-fisher",
    name: "Fisher Tomas",
    level: "object",
    parentId: "fountain-poi",
    kind: "npc",
    modifiedAt: 100,
    facts: makeFacts({ id: "npc-fisher", label: "Fisher Tomas", kind: "npc", components: ["Transform", "CharacterRef"], isQuestGiver: true }),
  },
  { id: "rock-1", name: "Boulder", level: "object", parentId: "market", kind: "rock", modifiedAt: 200, facts: makeFacts({ id: "rock-1", label: "Boulder", kind: "rock", components: ["Transform"] }) },
  { id: "gate-1", name: "Old Gate", level: "object", parentId: "market", kind: "dungeon-entrance", facts: makeFacts({ id: "gate-1", label: "Old Gate", kind: "dungeon-entrance", components: ["Transform"], isDungeonEntrance: true }) },
  { id: "quest-forge", name: "The Forge Trial", level: "object", parentId: "market", kind: "quest", references: { giverId: "npc-mara" } },
  { id: "coin-1", name: "Gold coin", level: "object", parentId: "fountain-poi", kind: "prop", facts: makeFacts({ id: "coin-1", label: "Gold coin", kind: "prop", components: ["Transform", "WorldItem"] }) },
  { id: "spawner-1", name: "Wolf den", level: "object", parentId: "market", kind: "spawner", facts: makeFacts({ id: "spawner-1", label: "Wolf den", kind: "spawner", components: ["Transform", "Spawner"] }) },
];

describe("hierarchy model", () => {
  it("builds containment scene → region → POI → object with full paths", () => {
    const model = buildHierarchy(data);
    assert.equal(model.roots.length, 1);
    assert.equal(model.roots[0].id, "haven");
    assert.equal(model.byId.get("npc-mara")?.path, "Haven / Market Square / Fountain / Blacksmith Mara");
    assert.equal(model.byId.get("market")?.children.map((c) => c.id).includes("fountain-poi"), true);
  });

  it("derives reference edges: quest → giver, vendor → template, creature → dialogue", () => {
    const model = buildHierarchy(data);
    const kinds = model.edges.map((e) => `${e.kind}:${e.from}->${e.to}`);
    assert.ok(kinds.includes("quest-giver:quest-forge->npc-mara"), kinds.join(","));
    assert.ok(kinds.includes("vendor-template:npc-mara->weapons-tier2"), kinds.join(","));
    assert.ok(kinds.includes("creature-dialogue:npc-mara->mara-dialogue"), kinds.join(","));
  });

  it("the quest-givers role filter returns exactly the quest givers", () => {
    const model = buildHierarchy(data);
    assert.deepEqual(
      filterByRole(model, "quest-givers").map((n) => n.id),
      ["npc-mara", "npc-fisher"],
    );
  });

  it("other role filters read the same facts", () => {
    const model = buildHierarchy(data);
    assert.deepEqual(filterByRole(model, "vendors").map((n) => n.id), ["npc-mara"]);
    assert.deepEqual(filterByRole(model, "dungeon-entrances").map((n) => n.id), ["gate-1"]);
    assert.deepEqual(filterByRole(model, "loot-spawners").map((n) => n.id), ["coin-1"]);
    assert.deepEqual(filterByRole(model, "mob-spawners").map((n) => n.id), ["spawner-1"]);
    assert.deepEqual(filterByRole(model, "environment").map((n) => n.id), ["coin-1", "rock-1"]);
    assert.deepEqual(filterByRole(model, "characters").map((n) => n.id), ["npc-mara", "npc-fisher"]);
  });

  it("sorts by name and by recently-modified (provenance timestamps)", () => {
    const model = buildHierarchy(data);
    const objects = model.flat.filter((n) => n.level === "object");
    assert.deepEqual(sortNodes(objects.slice(0, 3), "name").map((n) => n.name), ["Blacksmith Mara", "Fisher Tomas", "Gold coin"]);
    const recent = sortNodes(objects, "recent").map((n) => n.id);
    assert.ok(recent.indexOf("npc-mara") < recent.indexOf("rock-1"), recent.join(","));
    assert.ok(recent.indexOf("rock-1") < recent.indexOf("npc-fisher"), recent.join(","));
  });
});

describe("saved views", () => {
  it("round-trips through serialize/deserialize unchanged", () => {
    const view: SavedView = { name: "Vendors needing stock review", role: "vendors", sort: "recent", query: "mara" };
    assert.deepEqual(deserializeSavedView(serializeSavedView(view)), view);
    const noQuery: SavedView = { name: "All givers", role: "quest-givers", sort: "name" };
    assert.deepEqual(deserializeSavedView(serializeSavedView(noQuery)), noQuery);
  });

  it("rejects a saved view with an unknown role or sort", () => {
    assert.throws(() => deserializeSavedView(JSON.stringify({ name: "x", role: "bogus", sort: "name" })), /unknown role/);
    assert.throws(() => deserializeSavedView(JSON.stringify({ name: "x", role: "all", sort: "bogus" })), /unknown sort/);
  });

  it("applies role + query + sort together", () => {
    const model = buildHierarchy(data);
    const out = applySavedView(model, { name: "givers by name", role: "quest-givers", sort: "name" });
    assert.deepEqual(out.map((n) => n.id), ["npc-mara", "npc-fisher"]);
    const queried = applySavedView(model, { name: "mara only", role: "all", sort: "name", query: "mara" });
    assert.deepEqual(queried.map((n) => n.id), ["npc-mara"]);
  });
});
