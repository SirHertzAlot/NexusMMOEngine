/**
 * Ecology placement: deterministic and seamless (world-space cells), and
 * natural — satellites cluster round their parents and scree runs
 * downhill, spacing holds, reeds keep to the water line and lily pads
 * float, biomes change what grows.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadEcologyPlan, parseEcologyPlan, planChunk, type EcologyContext, type EcologyPlan } from "../../src/procgen/ecology.js";

const SIDE = 16; // samples per chunk side
const W = 16; // chunk metres

/** A chunk's heights from a function of world (x, z). */
function heights(cx: number, cz: number, f: (x: number, z: number) => number): Float32Array {
  const h = new Float32Array(SIDE * SIDE);
  for (let j = 0; j < SIDE; j++) {
    for (let i = 0; i < SIDE; i++) h[j * SIDE + i] = f(cx * W + (i * W) / (SIDE - 1), cz * W + (j * W) / (SIDE - 1));
  }
  return h;
}

const ctx = (cx: number, cz: number, f: (x: number, z: number) => number = () => 5, extra: Partial<EcologyContext> = {}): EcologyContext => ({
  worldSeed: 1234n,
  cx,
  cz,
  heights: heights(cx, cz, f),
  chunkWorldSize: W,
  ...extra,
});

const plan = (layers: unknown[], extra: Partial<EcologyPlan> = {}): EcologyPlan =>
  parseEcologyPlan({ version: 1, name: "test", fields: { f: { scale: 40, seed: 7 } }, biomes: {}, layers, ...extra });

const A = (asset: string) => [{ asset, weight: 1 }];

describe("ecology placement", () => {
  it("the shipped plan parses, and planning is deterministic", () => {
    const file = fileURLToPath(new URL("../../../content/ecology/wilds.ecology.json", import.meta.url));
    const { plan: wilds } = loadEcologyPlan(file);
    const hilly = (x: number, z: number): number => 5 + Math.sin(x / 7) * 2 + Math.cos(z / 5) * 1.5;
    // Its formation layers read neighbouring chunks through heightsOf.
    const heightsOf = (cx: number, cz: number): Float32Array => heights(cx, cz, hilly);
    const a = planChunk(wilds, ctx(3, -2, hilly, { heightsOf }));
    const b = planChunk(wilds, ctx(3, -2, hilly, { heightsOf }));
    assert.ok(a.length > 0);
    assert.deepEqual(a, b);
    assert.notDeepEqual(planChunk(wilds, ctx(4, -2, hilly, { heightsOf })).map((p) => p.x), a.map((p) => p.x));
    assert.throws(() => planChunk(wilds, ctx(3, -2, hilly)), /formation, which needs the terrain/);
  });

  it("field cells are world-space: one candidate per cell, owned by exactly one chunk", () => {
    const p = plan([{ id: "all", place: { kind: "field", spacing: 4 }, chance: 1, assets: A("x"), scale: [1, 1] }]);
    const cells = new Map<string, number>();
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      for (const pt of planChunk(p, ctx(cx, cz))) {
        assert.ok(pt.x >= cx * W && pt.x < (cx + 1) * W && pt.z >= cz * W && pt.z < (cz + 1) * W, "inside its chunk");
        const key = `${Math.floor(pt.x / 4)},${Math.floor(pt.z / 4)}`;
        cells.set(key, (cells.get(key) ?? 0) + 1);
      }
    }
    assert.equal(cells.size, 64, "every 4 m cell of the 32 m square");
    assert.ok([...cells.values()].every((n) => n === 1));
  });

  it("scree clusters round each boulder and runs down the fall line", () => {
    const p = plan([
      { id: "boulders", place: { kind: "field", spacing: 16 }, chance: 1, assets: A("boulder"), scale: [1, 1] },
      { id: "scree", place: { kind: "around", parent: "boulders", chance: 1, count: [8, 8], radius: [1, 3], downhill: 0.9 }, assets: A("pebble"), scale: [1, 1] },
    ]);
    // A slope falling toward +x.
    const pts = planChunk(p, ctx(0, 0, (x) => 20 - x * 0.6));
    const boulder = pts.find((q) => q.layer === "boulders")!;
    const scree = pts.filter((q) => q.layer === "scree");
    assert.ok(scree.length >= 4, `${scree.length} pebbles`);
    for (const s of scree) assert.ok(Math.hypot(s.x - boulder.x, s.z - boulder.z) <= 3 + 1e-6, "within the cluster radius");
    const meanDx = scree.reduce((acc, s) => acc + (s.x - boulder.x), 0) / scree.length;
    assert.ok(meanDx > 0.8, `scree drifts downhill (+x): mean dx ${meanDx.toFixed(2)}`);
  });

  it("spacing holds: trees keep apart, undergrowth stays out of the trunks", () => {
    const p = plan([
      { id: "trees", place: { kind: "field", spacing: 2 }, chance: 1, avoid: { trees: 3 }, assets: A("tree"), scale: [1, 1] },
      { id: "ferns", place: { kind: "around", parent: "trees", chance: 1, count: [4, 4], radius: [0, 3] }, avoid: { trees: 1 }, assets: A("fern"), scale: [1, 1] },
    ]);
    const pts = planChunk(p, ctx(0, 0));
    const trees = pts.filter((q) => q.layer === "trees");
    const ferns = pts.filter((q) => q.layer === "ferns");
    assert.ok(trees.length > 5 && ferns.length > 5);
    for (const a of trees) for (const b of trees) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 3);
    for (const f of ferns) for (const t of trees) assert.ok(Math.hypot(f.x - t.x, f.z - t.z) >= 1);
  });

  it("reeds keep to the water line; lily pads float on the shallows", () => {
    const p = plan([
      { id: "reeds", place: { kind: "field", spacing: 2 }, chance: 1, aboveWater: [-0.4, 0.4], assets: A("reed"), scale: [1, 1] },
      { id: "lilies", place: { kind: "field", spacing: 2 }, chance: 1, aboveWater: [-1.5, -0.4], onWater: true, assets: A("lily"), scale: [1, 1] },
    ]);
    // Ground rising from 2 m under the water (x = 0) to 3 m above it (x = 16); the surface at 10.
    const ground = (x: number): number => 8 + (x / W) * 5;
    const pts = planChunk(p, ctx(0, 0, ground, { waterAt: () => 10 }));
    const reeds = pts.filter((q) => q.layer === "reeds");
    const lilies = pts.filter((q) => q.layer === "lilies");
    assert.ok(reeds.length > 0 && lilies.length > 0);
    for (const r of reeds) assert.ok(Math.abs(ground(r.x) - 10) <= 0.4 + 1e-3, `reed at ${(ground(r.x) - 10).toFixed(2)} m`);
    for (const l of lilies) assert.equal(l.y, 10, "on the surface");
    // No water nearby: none of either.
    assert.equal(planChunk(p, ctx(0, 0, ground)).length, 0);
  });

  it("biomes change what grows: no trees on a glacier, pines in the mountains", () => {
    const p = plan(
      [{
        id: "trees", place: { kind: "field", spacing: 4 }, chance: 1, biome: "trees",
        assets: A("oak"), biomeAssets: { mountains: A("pine") }, scale: [1, 1],
      }],
      { biomes: { glacier: { trees: 0 }, mountains: { trees: 1 } } },
    );
    assert.equal(planChunk(p, ctx(0, 0, () => 5, { biomeAt: () => "glacier" })).length, 0);
    const mountain = planChunk(p, ctx(0, 0, () => 5, { biomeAt: () => "mountains" }));
    assert.ok(mountain.length > 0 && mountain.every((q) => q.assetId === "pine"));
    assert.ok(planChunk(p, ctx(0, 0)).every((q) => q.assetId === "oak"), "no biome map: the default assets");
  });

  it("rejects a plan whose layers reference what doesn't come before them", () => {
    assert.throws(() => plan([{ id: "a", place: { kind: "around", parent: "b", chance: 1, count: [1, 1], radius: [0, 1] }, assets: A("x"), scale: [1, 1] }]), /must come before/);
    assert.throws(() => plan([{ id: "a", place: { kind: "field", spacing: 4 }, density: [{ field: "nope", ramp: [0, 1] }], assets: A("x"), scale: [1, 1] }]), /unknown field/);
  });
});

describe("ecology categories (global scale)", () => {
  it("a layer's category rides on its spawns' archetype; none means the archetype has none (prop)", () => {
    const p = plan([
      { id: "trees", category: "tree", place: { kind: "field", spacing: 4 }, chance: 1, assets: A("t"), scale: [1, 1] },
      { id: "misc", place: { kind: "field", spacing: 4 }, chance: 1, assets: A("m"), scale: [1, 1] },
    ]);
    const pts = planChunk(p, ctx(0, 0));
    assert.ok(pts.some((x) => x.assetId === "t") && pts.some((x) => x.assetId === "m"));
    for (const pt of pts) assert.equal(pt.archetype.category, pt.assetId === "t" ? "tree" : undefined);
  });

  it("the shipped plan's trees, rocks and plants are categorised", () => {
    const file = fileURLToPath(new URL("../../../content/ecology/wilds.ecology.json", import.meta.url));
    const { plan: wilds } = loadEcologyPlan(file);
    const cat = (id: string) => wilds.layers.find((l) => l.id === id)?.category;
    assert.equal(cat("trees"), "tree");
    assert.equal(cat("outcrops"), "rock");
    assert.equal(cat("grass"), "plant");
  });

  it("an unknown category is refused", () => {
    assert.throws(() => plan([{ id: "x", category: "boulder", place: { kind: "field", spacing: 4 }, chance: 1, assets: A("x"), scale: [1, 1] }]), /category/);
  });
});
