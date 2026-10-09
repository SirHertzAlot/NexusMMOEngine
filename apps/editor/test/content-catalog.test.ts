/** The content catalog (EA15): everything the game defines, listed for the content browser and as a scene-viewport drag source. */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateScene, emptyScene } from "@mmo-engine/scene";
import { buildCatalog, handleCatalog } from "../src/content-catalog.js";

const REPO = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));
const ROOT = join(tmpdir(), `mmo-catalog-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);

before(() => {
  mkdirSync(join(ROOT, "packages"), { recursive: true });
  symlinkSync(join(REPO, "packages", "species"), join(ROOT, "packages", "species"), "junction");
  cpSync(join(REPO, "content"), join(ROOT, "content"), { recursive: true });
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

describe("buildCatalog", () => {
  it("lists species, creatures, item bases, prefabs, PICG assets, scenes and quests", async () => {
    const c = await buildCatalog(ROOT);
    const of = (kind: string): string[] => c.entries.filter((e) => e.kind === kind).map((e) => e.id);
    assert.ok(of("species").includes("void-watcher"));
    assert.deepEqual(of("creature"), ["goblin"]);
    assert.ok(of("item").includes("sword"));
    assert.deepEqual(of("prefab"), ["camps/goblin"]);
    assert.ok(of("picg").includes("oak"));
    assert.deepEqual(of("scene"), ["test-arena"]);
    assert.ok(of("quest").includes("goblin-trouble"));
    assert.ok(c.entries.every((e) => e.drag.kind === e.kind && e.drag.id === e.id));
  });

  it("gives creatures and prefabs a scene node that the scene validator accepts", async () => {
    const c = await buildCatalog(ROOT);
    for (const kind of ["creature", "prefab"]) {
      const e = c.entries.find((x) => x.kind === kind);
      assert.ok(e?.node, kind);
      const doc = { ...emptyScene("t", "arena"), nodes: [{ id: "n1", ...e.node }] };
      assert.deepEqual(validateScene(doc), [], kind);
    }
    assert.equal(c.entries.find((e) => e.kind === "quest")?.node, null);
  });

  it("answers GET and nothing else", async () => {
    assert.equal((await handleCatalog(ROOT, "GET")).status, 200);
    assert.equal((await handleCatalog(ROOT, "POST")).status, 404);
  });
});
