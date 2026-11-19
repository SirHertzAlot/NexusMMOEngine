/**
 * Detail layers: the placement evaluator is deterministic, respects the band,
 * affinity, tier thinning and the hard budget; the two surface contexts build
 * from a wall grid and from a chunk's masks.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { placeDetail, terrainSamples, wallBandSamples, type DetailSample, type DetailLayerSpec as DetailLayer } from "../src/detail.js";

const BASE: DetailLayer = {
  id: "test",
  assetSet: "test-set",
  surface: "floor",
  density: 0.6,
  noise: { scale: 4, threshold: 0 },
  band: { min: 0, max: 1 },
  affinity: { weight: 0, preference: 1 },
  cluster: { size: 0, falloff: 0 },
  seed: 7,
  budget: 1000000,
};

/** A grid of samples across [0, n) metres with a constant band and affinity. */
function grid(n: number, band: number, affinity: number): DetailSample[] {
  const out: DetailSample[] = [];
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) out.push({ x: x + 0.5, z: z + 0.5, band, affinity });
  return out;
}

describe("detail layer evaluator", () => {
  it("same seed, same samples: identical placements in the same order", () => {
    const s = grid(40, 0.5, 0.5);
    assert.deepEqual(placeDetail(BASE, s), placeDetail(BASE, s));
  });

  it("a different seed places differently", () => {
    const s = grid(40, 0.5, 0.5);
    assert.notDeepEqual(placeDetail(BASE, s), placeDetail({ ...BASE, seed: 8 }, s));
  });

  it("places nothing outside its band", () => {
    const s = [...grid(20, 0.1, 0), ...grid(20, 0.9, 0).map((p) => ({ ...p, x: p.x + 100 }))];
    const placed = placeDetail({ ...BASE, band: { min: 0.8, max: 1 } }, s);
    assert.ok(placed.length > 0);
    assert.ok(placed.every((p) => p.x >= 100), "only band-0.9 samples");
  });

  it("the budget is a hard cap, and the cut is deterministic", () => {
    const s = grid(60, 0.5, 0.5);
    const capped = placeDetail({ ...BASE, budget: 25 }, s);
    assert.equal(capped.length, 25);
    assert.deepEqual(capped, placeDetail({ ...BASE, budget: 25 }, s));
  });

  it("zero density places nothing", () => {
    assert.equal(placeDetail({ ...BASE, density: 0 }, grid(20, 0.5, 0.5)).length, 0);
  });

  it("tier thinning reduces the count, and tierScale 0 places nothing", () => {
    const s = grid(60, 0.5, 0.5);
    const full = placeDetail(BASE, s).length;
    const thin = placeDetail(BASE, s, 0.3).length;
    assert.ok(thin < full, `thin ${thin} < full ${full}`);
    assert.equal(placeDetail(BASE, s, 0).length, 0);
  });

  it("affinity at weight 0 does not change the count; at weight 1 it does", () => {
    const none = grid(60, 0.5, 0);
    const best = grid(60, 0.5, 1);
    assert.equal(placeDetail(BASE, none).length, placeDetail(BASE, best).length, "weight 0 ignores affinity");
    const weighted = { ...BASE, affinity: { weight: 1, preference: 1 } };
    assert.ok(placeDetail(weighted, none).length < placeDetail(weighted, best).length, "weight 1 prefers affinity");
  });

  it("clustering gathers placements into patches (fewer than unclustered, same budget)", () => {
    const s = grid(80, 0.5, 0.5);
    const plain = placeDetail(BASE, s).length;
    const clustered = placeDetail({ ...BASE, cluster: { size: 6, falloff: 0.1 } }, s).length;
    assert.ok(clustered < plain, `clustered ${clustered} < plain ${plain}`);
  });
});

describe("indoor context: wall-band rubble", () => {
  it("builds a band from the wall distance and a corner affinity", () => {
    // A 6×6 room of floor (0) inside a ring of walls (1).
    const w = 8, d = 8;
    const solid = new Uint8Array(w * d).fill(1);
    for (let z = 1; z < 7; z++) for (let x = 1; x < 7; x++) solid[z * w + x] = 0;
    const samples = wallBandSamples({ width: w, depth: d, cell: 1, solid });
    const corner = samples.find((s) => s.x === 1.5 && s.z === 1.5)!;
    const middle = samples.find((s) => s.x === 3.5 && s.z === 3.5)!;
    assert.equal(corner.affinity, 1, "corner");
    assert.equal(middle.affinity, 0, "open floor");
    assert.ok(corner.band < middle.band, "corner is nearer a wall");
  });

  it("rubble placed in the wall band sits against the walls only", () => {
    const w = 16, d = 16;
    const solid = new Uint8Array(w * d).fill(1);
    for (let z = 1; z < 15; z++) for (let x = 1; x < 15; x++) solid[z * w + x] = 0;
    const samples = wallBandSamples({ width: w, depth: d, cell: 1, solid });
    const rubble: DetailLayer = { ...BASE, surface: "floor", band: { min: 0, max: 1.5 }, density: 0.9 };
    const placed = placeDetail(rubble, samples);
    assert.ok(placed.length > 0);
    assert.ok(placed.every((p) => p.x < 2.5 || p.x > 13.5 || p.z < 2.5 || p.z > 13.5), "every rubble piece is within 1.5 m of a wall");
  });
});

describe("outdoor context: moss on the wet channel", () => {
  it("places moss where the wet channel is high and prefers the moist samples", () => {
    const n = 32;
    const wet = new Uint8Array(n * n);
    const moisture = new Uint8Array(n * n);
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      wet[z * n + x] = x < n / 2 ? 255 : 0;
      moisture[z * n + x] = wet[z * n + x];
    }
    const samples = terrainSamples({ width: n, depth: n, cell: 1, originX: 0, originZ: 0, channel: wet, moisture });
    const moss: DetailLayer = { ...BASE, surface: "terrain", band: { min: 0.5, max: 1 }, affinity: { weight: 1, preference: 1 }, density: 0.8 };
    const placed = placeDetail(moss, samples);
    assert.ok(placed.length > 0, "moss placed");
    assert.ok(placed.every((p) => p.x < n / 2), "only on the wet half");
  });
});
