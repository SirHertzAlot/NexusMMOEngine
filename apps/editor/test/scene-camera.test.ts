/**
 * Scene viewport camera helpers: the go-to parser and the fly-key axes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FLY_KEYS, flyAxes, parseGoTo } from "../src/ui/scene-camera.js";

describe("scene viewport go-to", () => {
  it("accepts two numbers separated by a comma or a space", () => {
    assert.deepEqual(parseGoTo("344, 576"), { x: 344, z: 576 });
    assert.deepEqual(parseGoTo("-1048 1040"), { x: -1048, z: 1040 });
    assert.deepEqual(parseGoTo("  12.5,-3  "), { x: 12.5, z: -3 });
  });

  it("rejects anything that is not two numbers", () => {
    for (const bad of ["", "344", "a, b", "1,2,3", "1,", "NaN, 4", "Infinity, 2"]) {
      assert.equal(parseGoTo(bad), null, `"${bad}" should be rejected`);
    }
  });
});

describe("scene viewport fly axes", () => {
  it("maps W/S to forward and back, D/A to right and left, E/Q to up and down", () => {
    assert.deepEqual(flyAxes(new Set(["w"])), { forward: 1, right: 0, up: 0 });
    assert.deepEqual(flyAxes(new Set(["s"])), { forward: -1, right: 0, up: 0 });
    assert.deepEqual(flyAxes(new Set(["d"])), { forward: 0, right: 1, up: 0 });
    assert.deepEqual(flyAxes(new Set(["a"])), { forward: 0, right: -1, up: 0 });
    assert.deepEqual(flyAxes(new Set(["e"])), { forward: 0, right: 0, up: 1 });
    assert.deepEqual(flyAxes(new Set(["q"])), { forward: 0, right: 0, up: -1 });
  });

  it("cancels opposite keys and combines diagonals", () => {
    assert.deepEqual(flyAxes(new Set(["w", "s"])), { forward: 0, right: 0, up: 0 });
    assert.deepEqual(flyAxes(new Set(["w", "d", "e"])), { forward: 1, right: 1, up: 1 });
  });

  it("uses only the fly keys, so the gizmo shortcuts are the only other claim on them", () => {
    assert.deepEqual([...FLY_KEYS].sort(), ["a", "d", "e", "q", "s", "w"]);
  });
});
