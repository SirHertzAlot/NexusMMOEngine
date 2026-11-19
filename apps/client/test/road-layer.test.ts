/**
 * RoadLayer (SG11): slabs become one draped mesh, re-draped as terrain loads, rebuilt only when needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RoadLayer } from "../src/render/roads/road-layer.js";

/** A slab's Transform as the spawner writes it: size in the scale, centre half its thickness above the ground. */
const slab = (x: number, z: number, yawDeg = 0, w = 6, len = 20) => {
  const half = (yawDeg * Math.PI) / 360;
  return { px: x, py: 10 + 0.05, pz: z, qy: Math.sin(half), qw: Math.cos(half), sx: w, sy: 0.1, sz: len };
};
const geo = (l: RoadLayer) => (l.group.children[0] as unknown as { geometry: { index: { count: number } | null; getAttribute(n: string): { count: number } }; visible: boolean });

describe("RoadLayer", () => {
  it("drapes every slab into one mesh, rebuilding at most once per interval", () => {
    const l = new RoadLayer();
    l.set(1n, slab(0, 0));
    l.set(2n, slab(30, 0, 90));
    assert.equal(l.count, 2);
    assert.equal(geo(l).visible, false, "nothing built yet");
    l.update(() => 10, 1000);
    assert.equal(geo(l).visible, true);
    const verts = geo(l).geometry.getAttribute("position").count;
    assert.equal(verts, 2 * (Math.ceil(20 / 2) + 1) * 2, "two legs of 11 samples, two rails");
    l.set(3n, slab(60, 0));
    l.update(() => 10, 1100); // too soon after the last build
    assert.equal(geo(l).geometry.getAttribute("position").count, verts, "waits for the interval");
    l.update(() => 10, 1300);
    assert.ok(geo(l).geometry.getAttribute("position").count > verts, "then takes the new street");
  });

  it("re-drapes a leg once the terrain under it has loaded, and then stops rebuilding", () => {
    const l = new RoadLayer();
    l.set(1n, slab(0, 0));
    let loaded = false;
    const ground = (_x: number, _z: number): number | null => (loaded ? 12 : null);
    l.update(ground, 1000);
    const top = (): number => (geo(l).geometry as unknown as { getAttribute(n: string): { array: Float32Array } }).getAttribute("position").array[1]!;
    assert.ok(Math.abs(top() - (10 + 0.1 + 0.03)) < 1e-4, "flat on the slab's top until the ground arrives");
    loaded = true;
    l.update(ground, 1300);
    assert.ok(Math.abs(top() - (12 + 0.03)) < 1e-4, "on the ground once it loads");
    const before = geo(l).geometry;
    l.update(ground, 5000);
    assert.equal(geo(l).geometry, before, "settled: no rebuild");
  });

  it("drops a street that went away, and a moved one is the same street", () => {
    const l = new RoadLayer();
    l.set(1n, slab(0, 0));
    l.set(2n, slab(30, 0));
    l.update(() => 10, 1000);
    l.set(1n, slab(0, 0)); // unchanged: no rebuild needed
    l.remove(2n);
    assert.equal(l.count, 1);
    l.update(() => 10, 1300);
    assert.equal(geo(l).geometry.getAttribute("position").count, (Math.ceil(20 / 2) + 1) * 2);
    l.remove(1n);
    l.update(() => 10, 1600);
    assert.equal(geo(l).visible, false, "an empty layer draws nothing");
  });
});
