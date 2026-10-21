/**
 * The global scale document (content/scale.json): one number for the whole
 * world, one per kind of object, and per-asset corrections, multiplied. The
 * server applies it where baked objects spawn so what the client draws and
 * what collides always agree.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCALE, SCALE_CATEGORIES, resolveScale, validateScale, type ScaleDoc } from "../src/index.js";

const doc = (over: Partial<ScaleDoc> = {}): ScaleDoc => ({ ...structuredClone(DEFAULT_SCALE), ...over });

describe("resolveScale", () => {
  it("is 1 for everything in the default document", () => {
    for (const c of SCALE_CATEGORIES) assert.equal(resolveScale(DEFAULT_SCALE, c), 1);
  });

  it("multiplies the global factor, the category factor and the asset's own", () => {
    const d = doc({ global: 2, categories: { building: 0.5 }, assets: { "pack/Tower": 1.5, "pack/Tree*": 0.8 } });
    assert.equal(resolveScale(d, "building"), 1, "2 x 0.5");
    assert.equal(resolveScale(d, "building", "pack/Tower"), 1.5, "2 x 0.5 x 1.5");
    assert.equal(resolveScale(d, "tree"), 2, "a category with no entry counts as 1");
    assert.equal(resolveScale(d, "tree", "pack/Tree_03"), 1.6, "a trailing * matches a prefix");
    assert.equal(resolveScale(d, "rock", "pack/Other"), 2);
  });

  it("takes the longest matching prefix, an exact id beating any prefix", () => {
    const d = doc({ assets: { "pack/*": 2, "pack/Tree*": 3, "pack/Tree_03": 5 } });
    assert.equal(resolveScale(d, "tree", "pack/Rock_01"), 2);
    assert.equal(resolveScale(d, "tree", "pack/Tree_01"), 3);
    assert.equal(resolveScale(d, "tree", "pack/Tree_03"), 5);
  });
});

describe("validateScale", () => {
  it("accepts the default document", () => {
    assert.deepEqual(validateScale(DEFAULT_SCALE), []);
  });

  it("names every problem with its path: version, ranges, unknown categories, non-numbers", () => {
    const issues = validateScale({ version: 2, global: 0, categories: { building: 99, castle: 1, tree: "big" }, assets: { "a/b": -1 } });
    assert.deepEqual(
      issues.map((i) => i.path).sort(),
      ["assets.a/b", "categories.building", "categories.castle", "categories.tree", "global", "version"],
    );
    assert.deepEqual(validateScale(null).map((i) => i.path), [""]);
  });
});
