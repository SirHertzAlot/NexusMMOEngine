/**
 * Clip-name normalisation (WL2 placeholder art): the Gobkit curated packs (walk, no dead) and the
 * community library (move, idle, attack) map to the same canonical names, and a missing dead clip
 * stays missing so the rig falls back to its procedural fall.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalClip, mapClips } from "../src/render/animal/clip-names.js";

describe("clip names", () => {
  it("maps the curated and community names to the same canonical clips", () => {
    assert.equal(canonicalClip("walk"), "walk");
    assert.equal(canonicalClip("move"), "walk");
    assert.equal(canonicalClip("Idle"), "idle");
    assert.equal(canonicalClip("attack"), "attack");
    assert.equal(canonicalClip("unknown_flap"), null);
  });

  it("picks the first source per canonical name, and leaves dead empty when a pack has none", () => {
    const curated = mapClips(["idle", "walk", "attack", "walk_fast"]);
    assert.equal(curated.walk, "walk");
    assert.equal(curated.dead, undefined);
    const community = mapClips(["move", "idle", "attack"]);
    assert.equal(community.walk, "move");
  });
});
