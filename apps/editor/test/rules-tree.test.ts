/**
 * Rules-tree helpers: loader-shaped path strings, immutable get/set
 * preserving key order, and per-path issue grouping.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatPath,
  getAtPath,
  groupIssues,
  removeAtPath,
  setAtPath,
} from "../src/rules-tree.js";

describe("formatPath", () => {
  it("matches the loader's field naming", () => {
    assert.equal(formatPath([]), "");
    assert.equal(formatPath(["gain", "fullAt"]), "gain.fullAt");
    assert.equal(formatPath(["parts", 3, "share"]), "parts[3].share");
    assert.equal(formatPath(["techniques", "cut", "skill"]), "techniques.cut.skill");
  });
});

describe("getAtPath", () => {
  const root = { gain: { base: 0.5 }, parts: [{ share: 1 }] };
  it("reads nested values", () => {
    assert.equal(getAtPath(root, ["gain", "base"]), 0.5);
    assert.equal(getAtPath(root, ["parts", 0, "share"]), 1);
  });
  it("yields undefined when absent", () => {
    assert.equal(getAtPath(root, ["gain", "nope"]), undefined);
    assert.equal(getAtPath(root, ["parts", 7]), undefined);
    assert.equal(getAtPath(root, ["parts", "share"]), undefined);
  });
});

describe("setAtPath", () => {
  it("sets immutably and keeps key order", () => {
    const root = { b: 1, a: { y: 1 } };
    const next = setAtPath(root, ["a", "y"], 2) as Record<string, Record<string, number>>;
    assert.deepEqual(next, { b: 1, a: { y: 2 } });
    assert.deepEqual(Object.keys(next), ["b", "a"]);
    assert.equal((root as typeof next).a.y, 1);
  });
  it("appends new keys and array items", () => {
    assert.deepEqual(setAtPath({}, ["gain", "base"], 0.5), { gain: { base: 0.5 } });
    assert.deepEqual(setAtPath([1], [1], 2), [1, 2]);
    assert.deepEqual(setAtPath(null, [], { bagSlots: 24 }), { bagSlots: 24 });
  });
});

describe("removeAtPath", () => {
  it("drops object keys, keeping the rest in order", () => {
    assert.deepEqual(removeAtPath({ a: 1, b: 2, c: 3 }, ["b"]), { a: 1, c: 3 });
  });
  it("splices arrays", () => {
    assert.deepEqual(removeAtPath(["x", "y", "z"], [1]), ["x", "z"]);
  });
  it("leaves absent paths alone", () => {
    const root = { a: 1 };
    assert.equal(removeAtPath(root, ["b"]), root);
    assert.equal(removeAtPath(root, []), root);
  });
});

describe("groupIssues", () => {
  it("groups messages by path", () => {
    const grouped = groupIssues([
      { file: "loot.json", path: "bagSlots", message: "a" },
      { file: "loot.json", path: "bagSlots", message: "b" },
      { file: "loot.json", path: "", message: "c" },
    ]);
    assert.deepEqual(grouped.get("bagSlots"), ["a", "b"]);
    assert.deepEqual(grouped.get(""), ["c"]);
  });
});
