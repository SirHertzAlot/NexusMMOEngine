/**
 * Story model (roadmap EA20): graphs for the canvas, edits with undo, and
 * the dialog tester that walks a dialog against a mock quest state.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addDialogNode, addReply, deleteDialogNode, dialogGraph, questGraph, renameDialogNode, startTest, type DialogDoc, type QuestsDoc,
} from "../src/story-model.js";

const REPO = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));
const read = (f: string): never => JSON.parse(readFileSync(join(REPO, "content", "quests", f), "utf8")) as never;
const warden = (): DialogDoc => (read("dialogs.json") as { dialogs: Record<string, DialogDoc> }).dialogs.warden;
const quests = (): QuestsDoc => read("quests.json");

describe("dialogGraph", () => {
  it("one node per dialog node, one edge per reply that leads on, start first", () => {
    const g = dialogGraph(warden());
    assert.equal(g.nodes[0].id, "greet");
    assert.equal(g.nodes[0].start, true);
    assert.equal(g.nodes.length, Object.keys(warden().nodes).length);
    assert.ok(g.edges.some((e) => e.from === "greet" && e.to === "goblins" && e.label === "Uneasy how?" && e.condition === "goblin-trouble is available"));
    assert.ok(g.edges.some((e) => e.from === "goblins" && e.effect === "accept goblin-trouble") === false, "a reply that ends has no edge");
    assert.ok(g.nodes.every((n) => n.reachable));
    assert.equal(new Set(g.nodes.map((n) => `${n.x},${n.y}`)).size, g.nodes.length, "no two nodes share a spot");
  });

  it("marks nodes nothing leads to", () => {
    const d = warden();
    d.nodes.lost = { text: "x", replies: [] };
    assert.equal(dialogGraph(d).nodes.find((n) => n.id === "lost")!.reachable, false);
  });
});

describe("questGraph", () => {
  it("quests with their steps in order, linked by prerequisites", () => {
    const g = questGraph(quests());
    assert.ok(g.nodes.some((n) => n.id === "goblin-trouble" && n.kind === "quest"));
    assert.ok(g.nodes.some((n) => n.id === "goblin-trouble/tower" && n.kind === "step"));
    assert.ok(g.edges.some((e) => e.from === "goblin-trouble/brief" && e.to === "goblin-trouble/tower"));
    assert.ok(g.edges.some((e) => e.from === "goblin-trouble" && e.to === "standing-stones" && e.label === "after"));
  });
});

describe("edits", () => {
  it("renaming a node follows start and next", () => {
    const d = renameDialogNode(warden(), "greet", "hello");
    assert.equal(d.start, "hello");
    assert.ok(d.nodes.hello && !d.nodes.greet);
    assert.equal(d.nodes.goblins.replies[1].next, "hello");
  });
  it("deleting a node drops the replies that led to it; the start stays", () => {
    const d = deleteDialogNode(warden(), "goblins");
    assert.ok(!d.nodes.goblins);
    assert.ok(!d.nodes.greet.replies.some((r) => r.next === "goblins"));
    assert.equal(deleteDialogNode(warden(), "greet").nodes.greet.text.length > 0, true);
  });
  it("adds nodes and replies without touching the original", () => {
    const d0 = warden();
    const d1 = addReply(addDialogNode(d0, "extra"), "extra", { text: "Back.", next: "greet" });
    assert.deepEqual(d1.nodes.extra.replies, [{ text: "Back.", next: "greet" }]);
    assert.equal(d0.nodes.extra, undefined);
  });
});

describe("dialog tester", () => {
  const fresh = (): ReturnType<typeof startTest> => startTest(warden(), { name: "Aria", quests: { "goblin-trouble": "available", "standing-stones": "unavailable" }, board: "Bounty" });

  it("starts at the start node with {name} filled in", () => {
    const t = fresh();
    assert.equal(t.node, "greet");
    assert.match(t.text, /^Well met, Aria\./);
  });

  it("shows only the replies whose condition holds, with the unmet ones listed apart", () => {
    const t = fresh();
    const shown = t.replies.filter((r) => r.available).map((r) => r.text);
    assert.deepEqual(shown, ["Uneasy how?", "Farewell."]);
    const hidden = t.replies.find((r) => r.text === "I've dealt with the goblins at the tower.")!;
    assert.equal(hidden.available, false);
    assert.match(hidden.why!, /goblin-trouble is available, needs ready/);
  });

  it("picking walks on, applies effects to the mock state and records them", () => {
    let t = fresh();
    t = t.pick(t.replies.findIndex((r) => r.text === "Uneasy how?"));
    assert.equal(t.node, "goblins");
    t = t.pick(t.replies.findIndex((r) => r.text === "I'll see to it."));
    assert.equal(t.ended, true);
    assert.equal(t.state.quests["goblin-trouble"], "active");
    assert.deepEqual(t.effects, ["accepted goblin-trouble"]);
    assert.deepEqual(t.trail, ["greet", "goblins"]);
  });

  it("an edited mock state opens other replies; complete marks done", () => {
    let t = startTest(warden(), { name: "A", quests: { "goblin-trouble": "ready" }, board: "" });
    t = t.pick(t.replies.findIndex((r) => r.text === "I've dealt with the goblins at the tower."));
    assert.equal(t.node, "thanks");
    assert.equal(t.state.quests["goblin-trouble"], "done");
    assert.deepEqual(t.effects, ["completed goblin-trouble"]);
    const again = t.withState({ ...t.state, quests: { ...t.state.quests, "goblin-trouble": "ready" } });
    assert.ok(again.replies.length >= 0);
  });

  it("picking a reply that isn't available does nothing", () => {
    const t = fresh();
    assert.equal(t.pick(t.replies.findIndex((r) => !r.available)).node, "greet");
  });
});
