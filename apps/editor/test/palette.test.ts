import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { catalogCommands, catalogTarget, rankCommands, type PaletteCommand } from "../src/palette.js";
import { CATALOG_KINDS, type CatalogEntry } from "../src/content-catalog-types.js";
import { pendingOpenAsset, requestOpenAsset, subscribeOpenAsset } from "../src/ui/open-asset.js";

const cmd = (label: string, group: PaletteCommand["group"] = "Command", hint?: string): PaletteCommand => ({
  id: label,
  label,
  group,
  hint,
  icon: "x",
  run: () => undefined,
});

describe("rankCommands", () => {
  const list = [
    cmd("World → Viewport", "Go to"),
    cmd("Gameplay → Tables", "Go to"),
    cmd("Tool: Rotate"),
    cmd("Save scene \"arena\"", "Command", "Ctrl S"),
    cmd("Item: sword", "Asset", "item base"),
  ];
  it("keeps the order for an empty query", () => {
    assert.deepEqual(rankCommands(list, "").map((c) => c.label), list.map((c) => c.label));
  });
  it("needs every word, in any order", () => {
    assert.deepEqual(rankCommands(list, "tables gameplay").map((c) => c.label), ["Gameplay → Tables"]);
    assert.deepEqual(rankCommands(list, "zzz"), []);
  });
  it("ranks a label that starts with the query first", () => {
    const l = [cmd("Reset layout"), cmd("Layout menu"), cmd("Play setup: 10 bots")];
    assert.equal(rankCommands(l, "lay")[0].label, "Layout menu");
  });
  it("ranks a word start above a match buried inside a word", () => {
    const l = [cmd("Terrain brush"), cmd("Veterinary: terra")];
    assert.equal(rankCommands(l, "terr")[0].label, "Terrain brush");
  });
  it("finds a command by its group or hint when the label lacks the word", () => {
    assert.deepEqual(rankCommands(list, "ctrl s").map((c) => c.label), ['Save scene "arena"']);
    assert.deepEqual(rankCommands(list, "asset").map((c) => c.label), ["Item: sword"]);
  });
  it("finds a command by keywords that are not in its label", () => {
    const l = [{ ...cmd("World → Viewport", "Go to"), keywords: "terrain sculpt brush" }, cmd("Scene → Viewport", "Go to")];
    assert.deepEqual(rankCommands(l, "terrain").map((c) => c.label), ["World → Viewport"]);
  });
  it("caps the result", () => {
    const many = Array.from({ length: 30 }, (_, i) => cmd(`Thing ${i}`));
    assert.equal(rankCommands(many, "thing", 5).length, 5);
  });
});

describe("catalog commands", () => {
  it("sends every catalog kind somewhere", () => {
    for (const k of CATALOG_KINDS) {
      const [ws, view] = catalogTarget(k);
      assert.ok(ws && view, k);
    }
  });
  it("makes one command per entry that goes to its editor", () => {
    const entries: CatalogEntry[] = [
      { kind: "creature", id: "goblin", label: "Goblin", detail: "health 60", drag: { kind: "creature", id: "goblin" }, node: null },
      { kind: "quest", id: "q1", label: "The Warden", detail: "quest", drag: { kind: "quest", id: "q1" }, node: null },
    ];
    const went: string[] = [];
    const cmds = catalogCommands(entries, (w, v) => went.push(`${w}/${v}`));
    assert.deepEqual(cmds.map((c) => c.label), ["Creature: Goblin", "Quest: The Warden"]);
    assert.ok(cmds.every((c) => c.group === "Asset"));
    cmds.forEach((c) => c.run());
    assert.deepEqual(went, ["gameplay/grids", "story/story-editor"]);
  });
  it("asks the panel to open the specific asset, not just its workspace", () => {
    const entries: CatalogEntry[] = [
      { kind: "scene", id: "arena", label: "Arena", detail: "scene", drag: { kind: "scene", id: "arena" }, node: null },
    ];
    const opened: Array<{ kind: string; id: string }> = [];
    const stop = subscribeOpenAsset((req) => opened.push(req));
    try {
      const cmds = catalogCommands(
        entries,
        () => undefined,
        (kind, id) => requestOpenAsset(kind, id),
      );
      cmds[0].run();
      assert.deepEqual(opened, [{ kind: "scene", id: "arena" }]);
    } finally {
      stop();
    }
  });
  it("works without an open callback (workspace navigation only)", () => {
    const entries: CatalogEntry[] = [
      { kind: "scene", id: "arena", label: "Arena", detail: "scene", drag: { kind: "scene", id: "arena" }, node: null },
    ];
    const went: string[] = [];
    const cmds = catalogCommands(entries, (w, v) => went.push(`${w}/${v}`));
    cmds[0].run();
    assert.deepEqual(went, ["scenes/scene"]);
  });
  it("a request made before its panel mounts waits for that panel", () => {
    requestOpenAsset("scene", "arena");
    assert.deepEqual(pendingOpenAsset("scene"), { kind: "scene", id: "arena" });
    const other: string[] = [];
    const stopOther = subscribeOpenAsset((req) => other.push(req.id), ["quest"]);
    assert.deepEqual(other, []);
    const opened: string[] = [];
    const stop = subscribeOpenAsset((req) => opened.push(req.id), ["scene"]);
    try {
      assert.deepEqual(opened, ["arena"]);
      assert.equal(pendingOpenAsset("scene"), undefined);
    } finally {
      stop();
      stopOther();
    }
  });
  it("only the latest waiting request per kind is kept", () => {
    requestOpenAsset("quest", "q1");
    requestOpenAsset("quest", "q2");
    const opened: string[] = [];
    const stop = subscribeOpenAsset((req) => opened.push(req.id), ["quest"]);
    stop();
    assert.deepEqual(opened, ["q2"]);
  });
});
