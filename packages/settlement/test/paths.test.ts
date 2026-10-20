/** The settlement CLIs' folders follow the MMO_* path variables (bake:all sets them), else the repo's content/. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { settlementPaths } from "../src/paths.js";

const repo = resolve("/r");
const at = (p: string): string => resolve(repo, p);

describe("settlementPaths", () => {
  it("defaults to the repo's content folder, scale file and assets catalog", () => {
    const p = settlementPaths({}, "/elsewhere", repo);
    assert.equal(p.settlements, at("content/settlements"));
    assert.equal(p.scenes, at("content/scenes"));
    assert.equal(p.scaleBase, at("content/scale.json"));
    assert.equal(p.scaleOut, at("content/scale.local.json"));
    assert.equal(p.catalog, at("assets/catalog.json"));
    assert.equal(p.rules, at("content/settlements/rules.json"));
  });
  it("derives everything from MMO_CONTENT_DIR and MMO_ASSETS_DIR", () => {
    const p = settlementPaths({ MMO_CONTENT_DIR: "/c", MMO_ASSETS_DIR: "/a" }, "/x", repo);
    assert.equal(p.settlements, resolve("/c/settlements"));
    assert.equal(p.scenes, resolve("/c/scenes"));
    assert.equal(p.scaleOut, resolve("/c/scale.local.json"));
    assert.equal(p.catalog, resolve("/a/catalog.json"));
    assert.equal(p.rules, at("content/settlements/rules.json"), "the rules are authored content: they stay with the repo");
    assert.equal(settlementPaths({ MMO_SETTLEMENT_RULES: "/r.json" }, "/x", repo).rules, resolve("/r.json"));
  });
  it("lets the specific variables win, and accepts the server's MMO_SCENES", () => {
    assert.equal(settlementPaths({ MMO_CONTENT_DIR: "/c", MMO_SCENES: "/s1" }, "/x", repo).scenes, resolve("/s1"));
    const p = settlementPaths({ MMO_SCENES: "/s1", MMO_SCENES_DIR: "/s2", MMO_SETTLEMENT_OUT: "/o", MMO_SCALE_OUT: "/o/s.json", MMO_CATALOG: "/cat.json" }, "/x", repo);
    assert.deepEqual([p.scenes, p.settlements, p.scaleOut, p.catalog], [resolve("/s2"), resolve("/o"), resolve("/o/s.json"), resolve("/cat.json")]);
  });
  it("resolves relative values from where npm was run, and MMO_REPO moves the defaults", () => {
    const p = settlementPaths({ MMO_SCENES_DIR: "out/scenes", MMO_REPO: "rel/repo" }, resolve("/work"), repo);
    assert.equal(p.scenes, resolve("/work/out/scenes"));
    assert.equal(p.catalog, resolve("/work/rel/repo/assets/catalog.json"));
  });
});
