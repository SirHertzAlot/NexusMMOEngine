// Golden tests: the C++ scatter addon must reproduce the JS reference
// evaluator (packages/scatter/src/reference.ts) bit-for-bit — same plan,
// same seeds, same heights -> deepStrictEqual spawn records.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseGraphJSON,
  cook,
  evaluatePlan,
} from "@mmo-engine/scatter";
import addon from "../index.js";

const scatterEntry = fileURLToPath(
  import.meta.resolve("@mmo-engine/scatter"),
);
const examplesDir = join(dirname(scatterEntry), "..", "..", "examples");

function forestPlan(overrides) {
  const json = JSON.parse(
    readFileSync(join(examplesDir, "forest.pcg.json"), "utf8"),
  );
  const g = parseGraphJSON(json);
  return cook(g, overrides ? { graph: "forest", params: overrides } : undefined);
}

// Flat height tile (all zeros); covers the chunk generously.
function flatGrid() {
  const n = 26;
  return {
    heights: new Float64Array(n * n),
    gridN: n,
    gridOx: -4,
    gridOz: -4,
    gridStep: 1,
  };
}

// Ramp tile height=x on a 0.5-step grid aligned so every slope sample
// of a jitter=0, spacing=4 graph lands exactly on a grid node.
function rampGrid() {
  const n = 34;
  const ox = -2;
  const oz = -2;
  const step = 0.5;
  const heights = new Float64Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      heights[iz * n + ix] = ox + ix * step;
    }
  }
  return { heights, gridN: n, gridOx: ox, gridOz: oz, gridStep: step };
}

function scatterCpp(plan, opts = {}) {
  const { worldSeed = 1234, cx = 0, cz = 0, grid = flatGrid() } = opts;
  return addon.scatterChunk({ plan, worldSeed, cx, cz, ...grid });
}

test("hashU32 golden vectors match the JS reference", () => {
  assert.equal(addon.hashU32(0), 0);
  assert.equal(addon.hashU32(1), 824515495);
  assert.equal(addon.hashU32(0xffffffff), 539527247);
});

test("hash01 / deriveChunkSeed golden vectors match", () => {
  assert.equal(addon.hash01(1), 824515495 / 4294967296);
  assert.equal(addon.deriveChunkSeed(1234, 0, 0), 3946782186);
  assert.notEqual(
    addon.deriveChunkSeed(1234, 0, 0),
    addon.deriveChunkSeed(1234, 1, 0),
  );
});

test("forest on flat terrain: bit-identical to the JS reference", () => {
  const plan = forestPlan();
  const js = evaluatePlan(plan, {
    worldSeed: 1234,
    cx: 0,
    cz: 0,
    heightAt: () => 0,
  });
  const cpp = scatterCpp(plan);
  assert.equal(js.length, 5);
  assert.equal(cpp.length, 5);
  assert.deepStrictEqual(cpp, js);
});

test("forest first-record goldens (locks the cross-language contract)", () => {
  const cpp = scatterCpp(forestPlan());
  const r = cpp[0];
  assert.equal(r.asset, "oak");
  assert.equal(r.seed, 931761186);
  assert.equal(r.variantSeed, 3510712232);
  assert.deepEqual(r.attrs, { biome: 1 });
  assert.equal(r.x, 6.439478397369385);
  assert.equal(r.z, 6.049421787261963);
  assert.equal(r.yaw, 4.474239826202393);
  assert.equal(r.sx, 0.7701156139373779);
});

test("density 1 keeps the full lattice; density 0 keeps nothing", () => {
  const all = forestPlan({ density: 1 });
  const jsAll = evaluatePlan(all, {
    worldSeed: 1234, cx: 0, cz: 0, heightAt: () => 0,
  });
  const cppAll = scatterCpp(all);
  assert.equal(jsAll.length, 16);
  assert.deepStrictEqual(cppAll, jsAll);

  const none = forestPlan({ density: 0 });
  assert.deepStrictEqual(scatterCpp(none), []);
});

test("slopeFilter on a ramp: bit-identical, drops when too steep", () => {
  const graph = {
    name: "ramp-test",
    version: 1,
    nodes: [
      { id: "s", type: "gridSampler",
        settings: { spacing: 4, jitter: 0, seed: 7 } },
      { id: "f", type: "slopeFilter", settings: { maxSlope: 0.6 } },
      { id: "t", type: "transformPoints",
        settings: { yawMin: 0, yawMax: 6.2831853,
                    scaleMin: 0.7, scaleMax: 1.4, seed: 21 } },
      { id: "m", type: "meshSpawner",
        settings: { entries: [{ asset: "oak", weight: 1 }], seed: 99 } },
    ],
    edges: [
      { from: "s", to: "f" },
      { from: "f", to: "t" },
      { from: "t", to: "m" },
    ],
  };
  const plan = cook(parseGraphJSON(graph));
  const grid = rampGrid();
  const jsDrop = evaluatePlan(plan, {
    worldSeed: 77, cx: 0, cz: 0, heightAt: (x) => x,
  });
  assert.equal(jsDrop.length, 0); // slope 1 > 0.6 everywhere
  assert.deepStrictEqual(scatterCpp(plan, { worldSeed: 77, grid }), jsDrop);

  // Loosen the slope limit: all 16 survive, transforms bit-identical.
  const loose = cook(parseGraphJSON({
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === "f"
        ? { ...n, settings: { maxSlope: 2 } }
        : n),
  }));
  const jsKeep = evaluatePlan(loose, {
    worldSeed: 77, cx: 0, cz: 0, heightAt: (x) => x,
  });
  assert.equal(jsKeep.length, 16);
  assert.deepStrictEqual(scatterCpp(loose, { worldSeed: 77, grid }), jsKeep);
});

test("world seed changes the scatter; chunks tile in world space", () => {
  const plan = forestPlan();
  const a = scatterCpp(plan, { worldSeed: 1 });
  const b = scatterCpp(plan, { worldSeed: 2 });
  assert.notDeepStrictEqual(a, b);

  const c0 = scatterCpp(plan, { cx: 0, cz: 0 });
  const c1 = scatterCpp(plan, { cx: 1, cz: 0 });
  for (const r of c0) assert.ok(r.x >= 0 && r.x < 16);
  for (const r of c1) assert.ok(r.x >= 16 && r.x < 32);
});

test("bilinear sampler: planar ramp interpolates exactly off grid nodes", () => {
  // Planar heightfield h(x,z) = 2x + 3z. Bilinear interpolation reproduces
  // a plane exactly, so every spawn's y must equal the plane at its (x,z) —
  // even though jitter pushes every sample point off the grid nodes.
  const n = 40;
  const ox = -2, oz = -2, step = 0.5;
  const heights = new Float64Array(n * n);
  for (let iz = 0; iz < n; iz++)
    for (let ix = 0; ix < n; ix++)
      heights[iz * n + ix] = 2 * (ox + ix * step) + 3 * (oz + iz * step);
  const grid = { heights, gridN: n, gridOx: ox, gridOz: oz, gridStep: step };
  const graph = {
    name: "plane-test",
    version: 1,
    nodes: [
      { id: "s", type: "gridSampler",
        settings: { spacing: 4, jitter: 0.7, seed: 7 } },
      { id: "t", type: "transformPoints",
        settings: { yawMin: 0, yawMax: 6.2831853,
                    scaleMin: 0.7, scaleMax: 1.4, seed: 21 } },
      { id: "m", type: "meshSpawner",
        settings: { entries: [{ asset: "oak", weight: 1 }], seed: 99 } },
    ],
    edges: [
      { from: "s", to: "t" },
      { from: "t", to: "m" },
    ],
  };
  const plan = cook(parseGraphJSON(graph));
  const js = evaluatePlan(plan, {
    worldSeed: 77, cx: 0, cz: 0, heightAt: (x, z) => 2 * x + 3 * z,
  });
  const cpp = scatterCpp(plan, { worldSeed: 77, grid });
  assert.equal(cpp.length, 16);
  assert.equal(js.length, 16);
  for (let i = 0; i < 16; i++) {
    const expected = Math.fround(2 * cpp[i].x + 3 * cpp[i].z);
    assert.ok(Math.abs(cpp[i].y - expected) < 1e-4,
      `native y=${cpp[i].y} vs plane ${expected}`);
    assert.ok(Math.abs(js[i].y - expected) < 1e-4,
      `js y=${js[i].y} vs plane ${expected}`);
    assert.ok(Math.abs(cpp[i].y - js[i].y) < 1e-4,
      `native/reference disagree: ${cpp[i].y} vs ${js[i].y}`);
  }
  // Jitter pushed every sample point off the 0.5-step grid nodes, so this
  // genuinely exercises interpolation rather than node passthrough.
  for (const r of cpp) {
    const fx = (r.x - ox) / step, fz = (r.z - oz) / step;
    assert.ok(Math.abs(fx - Math.round(fx)) > 1e-6, `x=${r.x} on a node`);
    assert.ok(Math.abs(fz - Math.round(fz)) > 1e-6, `z=${r.z} on a node`);
  }
});

test("invalid input throws clean JS errors", () => {
  const plan = forestPlan();
  const grid = flatGrid();
  assert.throws(() => addon.scatterChunk(), /one argument object/);
  assert.throws(
    () => addon.scatterChunk({ plan, worldSeed: 1, cx: 0, cz: 0 }),
    /heights must be a Float64Array/,
  );
  assert.throws(
    () =>
      addon.scatterChunk({
        plan, worldSeed: 1, cx: 0, cz: 0, ...grid,
        heights: new Float32Array(grid.gridN * grid.gridN),
      }),
    /heights must be a Float64Array/,
  );
  assert.throws(
    () => addon.scatterChunk({ plan, worldSeed: -1, cx: 0, cz: 0, ...grid }),
    /worldSeed must be a u32/,
  );
  const badOrder = { ...plan, order: ["nope"] };
  assert.throws(
    () => addon.scatterChunk({ plan: badOrder, worldSeed: 1, cx: 0, cz: 0, ...grid }),
    /unknown node/,
  );
  const badType = JSON.parse(JSON.stringify(plan));
  badType.nodes[0].type = "frobnicator";
  assert.throws(
    () => addon.scatterChunk({ plan: badType, worldSeed: 1, cx: 0, cz: 0, ...grid }),
    /unknown node type/,
  );
});
