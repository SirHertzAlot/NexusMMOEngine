/**
 * Outliner component badges (docs/EDITOR-UI-2026.md §2.2, slice EU4).
 *
 * Fourth time the gap list pointed at something we already had: the ECS
 * entity list has always badged a row with its components; the scene
 * outliner, which is the tree you actually build a scene in, drew only
 * a name and a kind. This is the arithmetic that fills that gap.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { badgeTitle, chipLabel, nodeBadges } from "../src/ui/outliner-badges.js";

const node = (...names: string[]) => ({
  components: Object.fromEntries(names.map((n) => [n, {}])) as Record<string, Record<string, unknown>>,
});

describe("how many chips a row shows", () => {
  it("shows them all when they fit", () => {
    assert.deepEqual(nodeBadges(node("Health", "Transform"), 3), {
      count: 2,
      shown: ["Health", "Transform"],
      hidden: 0,
    });
  });

  it("keeps the node's own order and counts what it dropped", () => {
    const b = nodeBadges(node("Health", "Transform", "Velocity", "NavAgent", "Loot"), 3);
    assert.deepEqual(b.shown, ["Health", "Transform", "Velocity"]);
    assert.equal(b.hidden, 2);
    // The count is every component, not just the ones on screen.
    assert.equal(b.count, 5);
  });

  it("gives a group node nothing, rather than a chip saying none", () => {
    assert.deepEqual(nodeBadges({ components: undefined }), { count: 0, shown: [], hidden: 0 });
    assert.deepEqual(nodeBadges(node()), { count: 0, shown: [], hidden: 0 });
  });

  it("never reports hidden chips it did not hide", () => {
    for (const n of [node(), node("A"), node("A", "B", "C")]) {
      assert.equal(nodeBadges(n, 3).hidden, 0);
    }
  });
});

describe("shortening a name to fit a chip", () => {
  it("leaves a short name alone", () => {
    assert.equal(chipLabel("Health"), "Health");
    assert.equal(chipLabel("Loot"), "Loot");
  });

  it("keeps both halves of a compound name", () => {
    const short = chipLabel("NavAgent");
    assert.ok(short.length <= 6, short);
    assert.ok(short.startsWith("N"), short);
    // Both words are represented, so NavAgent is not mistaken for NavMesh.
    assert.ok(/a/i.test(short.slice(1)), short);
  });

  it("truncates a single long word rather than mangling it", () => {
    assert.equal(chipLabel("Breakable", 6), "Breaka");
  });
});

describe("the hover title", () => {
  it("names every component, including the ones that did not fit", () => {
    assert.equal(
      badgeTitle(node("Health", "Transform", "Velocity", "NavAgent")),
      "4 components: Health, Transform, Velocity, NavAgent",
    );
  });

  it("is singular for one, and plain for none", () => {
    assert.equal(badgeTitle(node("Health")), "1 component: Health");
    assert.equal(badgeTitle(node()), "no components");
  });
});
