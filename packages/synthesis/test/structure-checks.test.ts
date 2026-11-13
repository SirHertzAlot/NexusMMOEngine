/**
 * Structure checks (the village synthesis pass): open kinds route away from buildings, detached parts are pruned,
 * a building must close.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SynthesizedPlacement } from "../src/types.js";
import { connectedComponents, envelopeReport, isOpenKind, placementBox, pruneDetached, synthesisRoute } from "../src/structure-checks.js";

const part = (partId: string, category: string, x: number, y: number, z: number, w: number, h: number, d: number, yaw = 0): SynthesizedPlacement => ({
  partId, assetRef: partId, category, size: [w, h, d],
  transform: { pos: [x, y, z], rot: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], scale: [1, 1, 1] } as SynthesizedPlacement["transform"],
});

describe("routing", () => {
  it("sends open ground away from the enclosed-building templates, whatever the key's prefix", () => {
    for (const k of ["garden", "building:garden", "structure:churchyard", "park", "empty_lot", "farm_field"]) assert.equal(synthesisRoute(k), "open", k);
    for (const k of ["house", "building:house", "tavern", "guardhouse", "town_hall"]) assert.equal(synthesisRoute(k), "enclosed", k);
    assert.equal(isOpenKind("building:garden"), true);
  });
});

describe("boxes and groups", () => {
  it("turns a part's box by its yaw", () => {
    const b = placementBox(part("w", "wall", 0, 1, 0, 6, 2, 1, Math.PI / 2));
    assert.ok(Math.abs(b.max[0] - b.min[0] - 1) < 1e-9 && Math.abs(b.max[2] - b.min[2] - 6) < 1e-9, "a 6 x 1 wall turned a quarter runs along z");
  });
  it("groups touching parts and keeps apart parts apart", () => {
    const ps = [part("a", "wall", 0, 1, 0, 4, 2, 1), part("b", "wall", 4, 1, 0, 4, 2, 1), part("c", "wall", 30, 1, 30, 4, 2, 1)];
    const g = connectedComponents(ps);
    assert.deepEqual(g.map((x) => x.parts.length).sort(), [1, 2]);
  });
});

describe("pruneDetached", () => {
  const house = [part("f", "floor", 0, 0.1, 0, 8, 0.2, 8), part("w1", "wall", 0, 1.2, 4, 8, 2, 0.2), part("w2", "wall", 0, 1.2, -4, 8, 2, 0.2), part("r", "roof", 0, 2.4, 0, 8, 0.4, 8)];
  it("drops a lone piece, a small stray group and a group in the air, and keeps the building", () => {
    const stray = part("lone", "wall", 40, 1, 40, 4, 2, 1);
    const pair = [part("p1", "wall", -40, 1, -40, 4, 2, 1), part("p2", "wall", -36, 1, -40, 4, 2, 1)];
    const floating = [part("a1", "wall", 20, 9, 20, 4, 2, 1), part("a2", "wall", 24, 9, 20, 4, 2, 1), part("a3", "wall", 28, 9, 20, 4, 2, 1)];
    const all = [...house, stray, ...pair, ...floating];
    const r = pruneDetached(all);
    assert.equal(r.kept.length, house.length);
    const why = Object.fromEntries(r.removed.map((x) => [all[x.index]!.partId, x.reason]));
    assert.equal(why.lone, "isolated");
    assert.equal(why.p1, "small-group");
    assert.equal(why.a1, "floating");
    assert.deepEqual(r.kept.map((p) => p.partId), ["f", "w1", "w2", "r"]);
  });
  it("keeps everything when it is one connected building", () => {
    assert.equal(pruneDetached(house).removed.length, 0);
  });
});

describe("envelopeReport", () => {
  const side = (n: string, x: number, z: number, along: "x" | "z") => part(n, "wall", x, 1.2, z, along === "x" ? 8 : 0.2, 2, along === "x" ? 0.2 : 8);
  const closed = [side("n", 0, 4, "x"), side("s", 0, -4, "x"), side("e", 4, 0, "z"), side("w", -4, 0, "z"), part("r", "roof", 0, 2.6, 0, 8, 0.4, 8)];
  it("is closed with walls on all four sides and a roof", () => {
    assert.deepEqual(envelopeReport(closed), { closed: true, missing: [] });
  });
  it("names what is missing: a wall side, a part-covered side, the roof", () => {
    const noWest = closed.filter((p) => p.partId !== "w");
    assert.deepEqual(envelopeReport(noWest).missing, ["west wall"]);
    const noRoof = closed.filter((p) => p.partId !== "r");
    assert.deepEqual(envelopeReport(noRoof).missing, ["roof"]);
    const halfNorth = closed.map((p) => (p.partId === "n" ? part("n", "wall", -2, 1.2, 4, 4, 2, 0.2) : p));
    assert.deepEqual(envelopeReport(halfNorth).missing, ["north wall"], "half the side is open");
  });
  it("counts overlapping wall parts once", () => {
    const doubled = [...closed, side("n2", 0, 4, "x")];
    assert.equal(envelopeReport(doubled).closed, true);
    const twoShortOverlapping = closed.map((p) => (p.partId === "n" ? part("n", "wall", 0, 1.2, 4, 3, 2, 0.2) : p)).concat([part("n3", "wall", 0, 1.2, 4, 3, 2, 0.2)]);
    assert.deepEqual(envelopeReport(twoShortOverlapping).missing, ["north wall"], "two parts on the same 3 m do not cover 8 m");
  });
});
