/**
 * Selecting more than one node, and what you can then do to them (EB2).
 *
 * The click rules are the part that goes wrong quietly — a ctrl-click that
 * silently replaces the set, a shift-click that ranges over the tree's
 * nesting rather than the rows on screen, a primary that disappears when
 * its node is deselected and takes the gizmo with it — so they are pinned
 * here, along with the arithmetic of align and distribute.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NO_SELECTION,
  clickSelection,
  extendSelection,
  pruneSelection,
  selectOnly,
  selectedSet,
  selectionLabel,
  toggleSelected,
} from "../src/scene-selection.js";
import {
  alignPositions,
  distributePositions,
  isMove,
  offsetPositions,
  positionDelta,
  type Positions,
} from "../src/scene-align.js";
import { AlignBar } from "../src/ui/align-bar.js";

const ORDER = ["a", "b", "c", "d", "e"];

describe("clicking", () => {
  it("replaces the set on a plain click", () => {
    const sel = clickSelection({ ids: ["a", "b"], primary: "b" }, ORDER, "d", {});
    assert.deepEqual(sel, { ids: ["d"], primary: "d" });
  });

  it("adds and removes on ctrl or cmd, and the newest is the primary", () => {
    let sel = selectOnly("a");
    sel = clickSelection(sel, ORDER, "c", { additive: true });
    assert.deepEqual(sel, { ids: ["a", "c"], primary: "c" });
    sel = clickSelection(sel, ORDER, "c", { additive: true });
    assert.deepEqual(sel, { ids: ["a"], primary: "a" }, "deselecting the primary hands it to what is left");
  });

  it("leaves nothing selected when the last node is ctrl-clicked away", () => {
    assert.deepEqual(toggleSelected(selectOnly("a"), "a"), { ids: [], primary: null });
  });

  it("ranges over the rows on screen, in either direction", () => {
    const sel = clickSelection(selectOnly("d"), ORDER, "b", { range: true });
    assert.deepEqual(sel.ids, ["b", "c", "d"]);
    assert.equal(sel.primary, "b", "the clicked end is the primary");
  });

  it("keeps a ctrl-built set outside the range it extends over", () => {
    const sel = extendSelection({ ids: ["e", "a"], primary: "a" }, ORDER, "c");
    assert.deepEqual(sel.ids, ["e", "a", "b", "c"]);
  });

  it("treats a shift-click with nothing selected as a plain one", () => {
    assert.deepEqual(extendSelection(NO_SELECTION, ORDER, "c"), { ids: ["c"], primary: "c" });
  });

  it("gives the viewport a lookup, and the toolbar a count", () => {
    assert.deepEqual([...selectedSet({ ids: ["a", "b"], primary: "b" })], ["a", "b"]);
    assert.equal(selectionLabel(NO_SELECTION), "Nothing selected");
    assert.equal(selectionLabel(selectOnly("a")), "1 node selected");
    assert.equal(selectionLabel({ ids: ["a", "b"], primary: "b" }), "2 nodes selected");
  });

  it("drops ids the document no longer has", () => {
    const left = pruneSelection({ ids: ["a", "b", "c"], primary: "c" }, (id) => id === "a");
    assert.deepEqual(left, { ids: ["a"], primary: "a" });
    const same = { ids: ["a"], primary: "a" };
    assert.equal(pruneSelection(same, () => true), same, "an unchanged selection is the same object");
  });
});

const ROW: Positions = {
  a: [0, 0, 0],
  b: [4, 1, 10],
  c: [10, 2, 2],
};

describe("align", () => {
  it("lines nodes up on an axis, and moves only what has to move", () => {
    const moved = alignPositions(ROW, 0, "min");
    assert.deepEqual(moved, { b: [0, 1, 10], c: [0, 2, 2] }, "a is already at the minimum");
  });
  it("centres on the middle of the spread, not on the average", () => {
    assert.deepEqual(alignPositions(ROW, 0, "centre").b, [5, 1, 10]);
  });
  it("aligns to the highest, and leaves the other axes alone", () => {
    const moved = alignPositions(ROW, 2, "max");
    assert.deepEqual(moved.a, [0, 0, 10]);
    assert.equal(moved.b, undefined);
  });
  it("does nothing to fewer than two nodes", () => {
    assert.deepEqual(alignPositions({ a: [0, 0, 0] }, 0, "min"), {});
  });
});

describe("distribute", () => {
  it("spaces nodes evenly, keeping the outermost two", () => {
    const moved = distributePositions(ROW, 0);
    assert.deepEqual(moved, { b: [5, 1, 10] });
  });
  it("sorts by the axis rather than by selection order", () => {
    const moved = distributePositions({ a: [10, 0, 0], b: [0, 0, 0], c: [3, 0, 0] }, 0);
    assert.deepEqual(moved, { c: [5, 0, 0] });
  });
  it("needs three nodes to mean anything", () => {
    assert.deepEqual(distributePositions({ a: [0, 0, 0], b: [8, 0, 0] }, 0), {});
  });
});

describe("dragging a set", () => {
  it("moves every node by the primary's delta", () => {
    const delta = positionDelta([1, 0, 1], [3, 0, -1]);
    assert.deepEqual(delta, [2, 0, -2]);
    assert.deepEqual(offsetPositions({ b: [4, 1, 10] }, delta), { b: [6, 1, 8] });
  });
  it("ignores a click that did not move anything", () => {
    assert.equal(isMove([0, 0, 0]), false);
    assert.equal(isMove([0, 1e-9, 0]), false);
    assert.equal(isMove([0, 0.001, 0]), true);
  });
});

describe("the align controls", () => {
  const bar = (count: number): string =>
    renderToStaticMarkup(React.createElement(AlignBar, { count, onAlign: () => undefined, onDistribute: () => undefined }));

  it("draws nothing for a single selection", () => {
    assert.equal(bar(1), "");
  });
  it("offers all three axes once there is a set", () => {
    const html = bar(2);
    assert.match(html, /data-testid="align-x-min"/);
    assert.match(html, /data-testid="align-z-max"/);
  });
  /** The whole opening tag of the button with this test id. */
  const tagOf = (html: string, testid: string): string =>
    new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`).exec(html)?.[0] ?? "";

  it("keeps spacing disabled until three nodes are selected", () => {
    assert.match(tagOf(bar(2), "distribute-x"), /disabled=""/);
    assert.doesNotMatch(tagOf(bar(3), "distribute-x"), /disabled=""/);
  });
});
