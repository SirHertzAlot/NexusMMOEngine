/**
 * Story host storage (roadmap EA20): whitelisted names, paths confined to
 * content/quests, a save validated as a set and written only when valid,
 * and the server's own loader reading what the editor saved. Writes go to a
 * throwaway repo root, never the real content.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkStory, isStoryFile, readStoryFile, resolveStoryPath, saveStoryFile, saveStoryFiles, storyFileNames } from "../src/story-host.js";

const REPO = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));
const ROOT = join(tmpdir(), `mmo-story-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const disk = (name: string): string => readFileSync(join(ROOT, "content", "quests", `${name}.json`), "utf8");

before(() => {
  mkdirSync(join(ROOT, "content", "rules"), { recursive: true });
  cpSync(join(REPO, "content", "quests"), join(ROOT, "content", "quests"), { recursive: true });
  for (const f of ["items", "creatures"]) cpSync(join(REPO, "content", "rules", `${f}.json`), join(ROOT, "content", "rules", `${f}.json`));
  // The server's quest loader is read from <root>/packages/engine-core/dist: borrow the real build.
  mkdirSync(join(ROOT, "packages"), { recursive: true });
  symlinkSync(join(REPO, "packages", "engine-core"), join(ROOT, "packages", "engine-core"), "junction");
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

describe("story file names", () => {
  it("lists the four documents the server loads", () => {
    assert.deepEqual(storyFileNames(), ["quests", "dialogs", "npcs", "steps"]);
  });
  it("rejects traversal, extensions and case", () => {
    for (const n of ["", "../server", "quests.json", "quests/", "QUESTS", "rules"]) {
      assert.equal(isStoryFile(n), false, n);
      assert.throws(() => resolveStoryPath(ROOT, n), (e: unknown) => (e as { status?: number }).status === 404, n);
    }
    assert.equal(resolveStoryPath(ROOT, "dialogs"), join(ROOT, "content", "quests", "dialogs.json"));
  });
});

describe("readStoryFile", () => {
  it("returns the content and the rules references", () => {
    const r = readStoryFile(ROOT, "quests");
    assert.ok((r.content as Any).quests["goblin-trouble"]);
    assert.ok(r.refs.items.includes("sword"));
    assert.ok(r.refs.species.includes("goblin"));
  });
});

describe("saveStoryFile", () => {
  it("author a quest with a dialog, save it, reload it, and the server loads it", async () => {
    const quests = JSON.parse(disk("quests")) as Any;
    quests.quests["rat-problem"] = {
      name: "Rat problem",
      giver: "warden",
      summary: "Rats in the cellar.",
      steps: [
        { id: "brief", text: "Speak with Warden Hale.", objective: { type: "talk", npc: "warden" } },
        { id: "clear", text: "Kill the goblins (2).", objective: { type: "kill", kind: "goblin", count: 2 } },
      ],
      rewards: [{ base: "dagger" }],
    };
    const dialogs = JSON.parse(disk("dialogs")) as Any;
    const nodes = dialogs.dialogs.warden.nodes;
    nodes.rats = { text: "Rats, {name}.", replies: [{ text: "On it.", do: { accept: "rat-problem" } }, { text: "No.", next: "greet" }] };
    nodes.greet.replies.unshift({ text: "About the rats...", next: "rats-hub" });
    nodes["rats-hub"] = {
      text: "The cellar again?",
      replies: [
        { text: "Done with the rats.", if: { quest: "rat-problem", is: "ready" }, do: { complete: "rat-problem" }, next: "thanks" },
        { text: "Any rats?", if: { quest: "rat-problem", is: "available" }, next: "rats" },
        { text: "Never mind.", next: "greet" },
      ],
    };
    // A quest alone is fine (warnings only: nothing hands it out yet).
    const first = await saveStoryFile(ROOT, "quests", quests);
    assert.ok(first.every((i) => i.severity === "warning"));
    await saveStoryFile(ROOT, "dialogs", dialogs);
    assert.deepEqual(await checkStory(ROOT, { quests: JSON.parse(disk("quests")), dialogs: JSON.parse(disk("dialogs")), npcs: JSON.parse(disk("npcs")), steps: JSON.parse(disk("steps")) }), []);

    const reread = readStoryFile(ROOT, "quests").content as Any;
    assert.equal(reread.quests["rat-problem"].name, "Rat problem");

    const mod = (await import(pathToFileURL(join(ROOT, "packages", "engine-core", "dist", "src", "quests", "content.js")).href)) as {
      loadQuestContent(dir: string): { quests: Record<string, unknown>; dialogs: Record<string, { nodes: Record<string, unknown> }> };
    };
    const loaded = mod.loadQuestContent(join(ROOT, "content", "quests"));
    assert.ok(loaded.quests["rat-problem"]);
    assert.ok(loaded.dialogs.warden.nodes.rats);
  });

  it("an invalid save writes nothing", async () => {
    const before = disk("dialogs");
    const bad = JSON.parse(before) as Any;
    bad.dialogs.warden.nodes.greet.replies[0].next = "void";
    await assert.rejects(saveStoryFile(ROOT, "dialogs", bad), (e: Any) => e.status === 400 && e.issues.some((i: Any) => /void/.test(i.message)));
    assert.equal(disk("dialogs"), before);

    const badQuests = JSON.parse(disk("quests")) as Any;
    const prior = disk("quests");
    badQuests.quests["goblin-trouble"].steps[2].objective.kind = "dragon";
    await assert.rejects(saveStoryFile(ROOT, "quests", badQuests), (e: Any) => e.status === 400);
    assert.equal(disk("quests"), prior);
  });

  it("saves files that need each other together, all or nothing", async () => {
    const quests = JSON.parse(disk("quests")) as Any;
    const dialogs = JSON.parse(disk("dialogs")) as Any;
    delete quests.quests["rat-problem"];
    // Dropping the quest alone breaks the dialog that names it; both together are fine.
    await assert.rejects(saveStoryFile(ROOT, "quests", quests), (e: Any) => e.status === 400);
    delete dialogs.dialogs.warden.nodes.rats;
    delete dialogs.dialogs.warden.nodes["rats-hub"];
    dialogs.dialogs.warden.nodes.greet.replies.shift();
    const priorQ = disk("quests");
    await assert.rejects(saveStoryFiles(ROOT, { quests, dialogs: { ...dialogs, dialogs: { warden: { start: "void", nodes: {} } } } }), (e: Any) => e.status === 400);
    assert.equal(disk("quests"), priorQ, "one bad file keeps the good one from being written");
    await saveStoryFiles(ROOT, { quests, dialogs });
    assert.equal((JSON.parse(disk("quests")) as Any).quests["rat-problem"], undefined);
  });

  it("refuses a name off the whitelist", async () => {
    await assert.rejects(saveStoryFile(ROOT, "../../package", {}), (e: Any) => e.status === 404);
  });
});
