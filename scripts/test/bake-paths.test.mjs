import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { resolvePaths } from "../lib/bake-paths.mjs";

const repo = resolve("/r");
const cwd = resolve("/work");
const ok = () => true;
const at = (...p) => resolve(repo, ...p);
const make = (env = {}, flags = {}, exists = ok) => resolvePaths({ env, flags, initCwd: cwd, repo, exists });

describe("resolvePaths", () => {
  it("defaults are relative to the repo root", () => {
    const p = make();
    assert.equal(p.repo, repo);
    assert.equal(p.dataDir, at("packages/engine-core/data"));
    assert.equal(p.contentDir, at("content"));
    assert.equal(p.assetsDir, at("assets"));
    assert.equal(p.catalog, at("assets/catalog.json"));
    assert.equal(p.worldSpec, at("packages/engine-core/worlds/default.world.json"));
    assert.equal(p.settlementOut, at("content/settlements"));
    assert.equal(p.scenesDir, at("content/scenes"));
    assert.equal(p.scaleOut, at("content/scale.local.json"));
    assert.equal(p.sources.dataDir, "default");
  });

  it("content and assets derive their children; the specific variable wins", () => {
    const p = make({ MMO_CONTENT_DIR: "/c", MMO_ASSETS_DIR: "/a", MMO_SCALE_OUT: "/o/scale.json" });
    assert.equal(p.settlementOut, resolve("/c/settlements"));
    assert.equal(p.scenesDir, resolve("/c/scenes"));
    assert.equal(p.catalog, resolve("/a/catalog.json"));
    assert.equal(p.scaleOut, resolve("/o/scale.json"));
    assert.equal(make({ MMO_CATALOG: "/x.json", MMO_ASSETS_DIR: "/a" }).catalog, resolve("/x.json"));
  });

  it("the server's MMO_SCENES is an alias; MMO_SCENES_DIR wins over it", () => {
    assert.equal(make({ MMO_SCENES: "/s" }).scenesDir, resolve("/s"));
    assert.equal(make({ MMO_SCENES: "/s", MMO_SCENES_DIR: "/d" }).scenesDir, resolve("/d"));
  });

  it("flags beat environment variables", () => {
    const p = make({ MMO_DATA_DIR: "/env" }, { "data-dir": "/flag", "scenes-dir": "/f/scenes" });
    assert.equal(p.dataDir, resolve("/flag"));
    assert.equal(p.scenesDir, resolve("/f/scenes"));
    assert.equal(p.sources.dataDir, "--data-dir");
    assert.equal(make({ MMO_DATA_DIR: "/env" }).sources.dataDir, "MMO_DATA_DIR");
  });

  it("relative values resolve from where npm was run, not the repo", () => {
    const p = make({ MMO_DATA_DIR: "out/data" }, { "content-dir": "cc" });
    assert.equal(p.dataDir, resolve(cwd, "out/data"));
    assert.equal(p.contentDir, resolve(cwd, "cc"));
    assert.equal(p.scenesDir, resolve(cwd, "cc/scenes"));
  });

  it("empty variables count as unset", () => {
    assert.equal(make({ MMO_DATA_DIR: "" }).dataDir, at("packages/engine-core/data"));
  });

  it("rejects what cannot work, naming the variable", () => {
    assert.throws(() => make({}, { "data-dir": true }), /--data-dir needs a value/);
    assert.throws(() => make({}, {}, (f) => !f.endsWith("default.world.json")), /MMO_WORLD_SPEC.*does not exist/s);
    assert.throws(() => make({ MMO_CATALOG: "bad\0name" }), /MMO_CATALOG/);
    assert.throws(() => make({ MMO_DATA_DIR: resolve(repo, "assets/x") }), /MMO_DATA_DIR.*assets/s);
    assert.throws(() => make({ MMO_SETTLEMENT_OUT: resolve(repo, "assets") }), /MMO_SETTLEMENT_OUT.*assets/s);
  });

  it("never writes into the assets folder, wherever it is", () => {
    assert.throws(() => make({ MMO_ASSETS_DIR: "/a", MMO_SCENES_DIR: "/a/scenes" }), /MMO_SCENES_DIR.*MMO_ASSETS_DIR/s);
  });

  it("the catalog may be missing: that is reported, not an error", () => {
    const p = make({}, {}, (f) => !f.endsWith("catalog.json"));
    assert.equal(p.hasCatalog, false);
    assert.equal(make().hasCatalog, true);
  });
});
