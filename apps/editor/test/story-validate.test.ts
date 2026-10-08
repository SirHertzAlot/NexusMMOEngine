/**
 * Quest and dialog validation (roadmap EA20): the server's own schemas and
 * cross-file checks, plus references into the rules (item bases, species),
 * quest prerequisite cycles, dialog loops with no way out, and quests no
 * dialog can hand out or take in.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dialogCycles, validateStory, type StoryFiles } from "../src/story-validate.js";
import { loadQuestServer } from "../src/story-host.js";

const REPO = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));
const read = (f: string): unknown => JSON.parse(readFileSync(join(REPO, "content", "quests", f), "utf8"));
const shipped = (): StoryFiles => ({ steps: read("steps.json"), quests: read("quests.json"), npcs: read("npcs.json"), dialogs: read("dialogs.json") }) as StoryFiles;
const refs = { items: new Set(["sword", "amulet", "dagger", "axe", "mace"]), species: new Set(["goblin"]) };
const server = await loadQuestServer(REPO);
const check = (f: StoryFiles) => validateStory(f, refs, server);
const errs = (f: StoryFiles) => check(f).filter((i) => i.severity === "error");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe("validateStory", () => {
  it("the shipped set has no errors", () => {
    assert.deepEqual(errs(shipped()), []);
  });

  it("reports schema errors per path", () => {
    const f = shipped() as Any;
    f.quests.quests["goblin-trouble"].steps[2].objective.count = 0;
    assert.ok(errs(f).find((i) => i.file === "quests" && i.path === "quests.goblin-trouble.steps.2.objective.count"), JSON.stringify(errs(f)));
  });

  it("reports server cross-file problems (missing dialog node)", () => {
    const f = shipped() as Any;
    f.dialogs.dialogs.warden.nodes.goblins.replies[1].next = "void";
    assert.ok(errs(f).some((i) => i.file === "dialogs" && /missing node "void"/.test(i.message)));
  });

  it("flags unknown species and item bases", () => {
    const f = shipped() as Any;
    f.quests.quests["goblin-trouble"].steps[2].objective.kind = "dragon";
    f.quests.quests["goblin-trouble"].rewards = [{ base: "spoon" }];
    const e = errs(f);
    assert.ok(e.some((i) => i.path === "quests.goblin-trouble.steps.2.objective.kind" && /dragon/.test(i.message)));
    assert.ok(e.some((i) => i.path === "quests.goblin-trouble.rewards.0.base" && /spoon/.test(i.message)));
  });

  it("flags a prerequisite cycle between quests", () => {
    const f = shipped() as Any;
    f.quests.quests["goblin-trouble"].after = ["standing-stones"];
    assert.ok(errs(f).some((i) => /prerequisite cycle/.test(i.message)));
  });

  it("flags a dialog loop with no way out; a hub loop is fine", () => {
    const f = shipped() as Any;
    const nodes = f.dialogs.dialogs.warden.nodes;
    nodes.trap = { text: "a", replies: [{ text: "b", next: "trap2" }] };
    nodes.trap2 = { text: "b", replies: [{ text: "a", next: "trap" }] };
    nodes.goblins.replies.push({ text: "enter", next: "trap" });
    assert.equal(errs(f).filter((i) => /no way out/.test(i.message)).length, 1);
    const cycles = dialogCycles(f.dialogs.dialogs.warden);
    assert.ok(cycles.some((c) => !c.exits && c.nodes.includes("trap")));
    assert.ok(cycles.some((c) => c.exits && c.nodes.includes("greet")));
  });

  it("warns when no dialog accepts or completes a quest", () => {
    const f = shipped() as Any;
    f.quests.quests.orphan = { name: "Orphan", giver: "warden", summary: "s", steps: [{ id: "a", text: "t", objective: { type: "talk", npc: "warden" } }] };
    const w = check(f).filter((i) => i.severity === "warning");
    assert.ok(w.some((i) => i.path === "quests.orphan" && /accept/.test(i.message)));
    assert.ok(w.some((i) => i.path === "quests.orphan" && /complete/.test(i.message)));
  });
});
