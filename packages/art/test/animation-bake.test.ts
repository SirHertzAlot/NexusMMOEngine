/**
 * TL5: Animation bake pipeline interface tests.
 *
 * Verifies the contract (types, error messages) without the native addon.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  retargetClip,
  compressClip,
  validateClip,
  hasAnimationAddon,
} from "../src/animation-bake.js";

const dummySkeleton = {
  bones: ["root", "spine", "head"],
  parents: [-1, 0, 1],
};

describe("animation-bake interface", () => {
  it("reports addon as unavailable", () => {
    assert.equal(hasAnimationAddon(), false);
  });

  it("retargetClip throws with helpful message", () => {
    assert.throws(
      () => retargetClip(new ArrayBuffer(8), dummySkeleton, dummySkeleton),
      /native ozz addon not implemented/
    );
  });

  it("compressClip throws with helpful message", () => {
    assert.throws(
      () => compressClip(new ArrayBuffer(8), 0.1),
      /native acl addon not implemented/
    );
  });

  it("validateClip throws with helpful message", () => {
    assert.throws(
      () => validateClip(new ArrayBuffer(8)),
      /native ozz addon not implemented/
    );
  });
});
