/**
 * Shared scope tree (editor DRY slice 1): every outliner renders the same
 * data-driven rows instead of reimplementing open/selected/breadcrumb
 * around TreeItem. Pure helpers, tested here; the ScopeTree renderer in
 * ui/components wraps TreeItem with them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  breadcrumb,
  flattenVisible,
  toggleOpen,
  type ScopeNode,
} from "../src/ui/scope-tree.js";

const TREE: ScopeNode[] = [
  {
    id: "world", label: "default.world", trailing: "4 × 4 km", children: [
      {
        id: "regions", label: "Regions", trailing: "4", children: [
          { id: "r00", label: "Region 0,0", trailing: "loaded" },
          { id: "r10", label: "Region 1,0" },
        ],
      },
      { id: "sky", label: "Sky, day and weather" },
    ],
  },
];

describe("toggleOpen", () => {
  it("opens a closed id and closes an open one, keeping the rest", () => {
    assert.deepEqual(toggleOpen([], "world"), ["world"]);
    assert.deepEqual(toggleOpen(["world", "regions"], "world"), ["regions"]);
    assert.deepEqual(toggleOpen(["world"], "regions"), ["world", "regions"]);
  });
});

describe("flattenVisible", () => {
  it("shows only roots when nothing is open, with depths", () => {
    assert.deepEqual(flattenVisible(TREE, []).map((r) => [r.node.id, r.depth]), [["world", 0]]);
  });

  it("expands open subtrees in order", () => {
    const rows = flattenVisible(TREE, ["world", "regions"]).map((r) => [r.node.id, r.depth]);
    assert.deepEqual(rows, [
      ["world", 0],
      ["regions", 1],
      ["r00", 2],
      ["r10", 2],
      ["sky", 1],
    ]);
  });
});

describe("breadcrumb", () => {
  it("returns the root-to-node path for the selected id", () => {
    assert.deepEqual(breadcrumb(TREE, "r10").map((n) => n.id), ["world", "regions", "r10"]);
    assert.deepEqual(breadcrumb(TREE, "world").map((n) => n.id), ["world"]);
  });

  it("returns an empty path for an unknown id", () => {
    assert.deepEqual(breadcrumb(TREE, "nope"), []);
  });
});
