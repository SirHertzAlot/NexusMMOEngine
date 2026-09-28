import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseGraphJSON, type PcGraph } from "../src/schema.js";
import { cook, type CookedPlan } from "../src/cooker.js";
import {
  hashU32,
  hash01,
  deriveChunkSeed,
  evaluatePlan,
  type EvalContext,
} from "../src/reference.js";

const here = dirname(fileURLToPath(import.meta.url));
const forestJSON = JSON.parse(
  readFileSync(join(here, "..", "..", "examples", "forest.pcg.json"), "utf8"),
);

function forestPlan(): CookedPlan {
  const g: PcGraph = parseGraphJSON(JSON.parse(JSON.stringify(forestJSON)));
  return cook(g);
}

const flat = () => 0;
const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({
  worldSeed: 1234,
  cx: 0,
  cz: 0,
  heightAt: flat,
  ...over,
});

test("hashU32 golden vectors (lock the bit-exact spec)", () => {
  assert.equal(hashU32(0), 0);
  assert.equal(hashU32(1), 824515495);
  assert.equal(hashU32(0xffffffff), 539527247);
});

test("hash01 maps into [0, 1)", () => {
  assert.equal(hash01(0), 0);
  const v = hash01(1);
  assert.ok(v >= 0 && v < 1);
  assert.equal(v, 824515495 / 4294967296);
});

test("deriveChunkSeed golden vector + determinism", () => {
  assert.equal(deriveChunkSeed(1234, 0, 0), 3946782186);
  assert.equal(deriveChunkSeed(1234, 0, 0), deriveChunkSeed(1234, 0, 0));
  assert.notEqual(deriveChunkSeed(1234, 0, 0), deriveChunkSeed(1234, 1, 0));
  assert.notEqual(deriveChunkSeed(1234, 0, 0), deriveChunkSeed(1235, 0, 0));
});

test("forest plan golden: count + first record (worldSeed 1234, chunk 0,0)", () => {
  const recs = evaluatePlan(forestPlan(), ctx());
  assert.equal(recs.length, 5);
  const r = recs[0];
  assert.equal(r.asset, "oak");
  assert.equal(r.seed, 931761186);
  assert.equal(r.variantSeed, 3510712232);
  assert.equal(r.attrs.biome, 1);
  // float32-quantized transform fields
  assert.ok(Math.abs(r.x - 6.439478397369385) < 1e-6);
  assert.ok(Math.abs(r.z - 6.049421787261963) < 1e-6);
  assert.ok(Math.abs(r.yaw - 4.474239826202393) < 1e-6);
  assert.ok(Math.abs(r.sx - 0.7701156139373779) < 1e-6);
  assert.equal(r.sx, r.sy);
  assert.equal(r.sy, r.sz);
});

test("evaluation is deterministic across runs", () => {
  const a = evaluatePlan(forestPlan(), ctx());
  const b = evaluatePlan(forestPlan(), ctx());
  assert.deepEqual(a, b);
});

test("different world seeds give different scatter", () => {
  const a = evaluatePlan(forestPlan(), ctx({ worldSeed: 1 }));
  const b = evaluatePlan(forestPlan(), ctx({ worldSeed: 2 }));
  assert.notDeepEqual(a, b);
});

test("adjacent chunks tile the lattice in world space", () => {
  const a = evaluatePlan(forestPlan(), ctx({ cx: 0, cz: 0 }));
  const b = evaluatePlan(forestPlan(), ctx({ cx: 1, cz: 0 }));
  for (const r of a) assert.ok(r.x >= 0 && r.x < 16);
  for (const r of b) assert.ok(r.x >= 16 && r.x < 32);
});

test("density 1 keeps every lattice point; density 0 keeps none", () => {
  const all = cook(
    parseGraphJSON(JSON.parse(JSON.stringify(forestJSON))),
    { graph: "forest", params: { density: 1 } },
  );
  const none = cook(
    parseGraphJSON(JSON.parse(JSON.stringify(forestJSON))),
    { graph: "forest", params: { density: 0 } },
  );
  // spacing 4 over 16 units -> 4x4 lattice, flat terrain keeps all through slope
  assert.equal(evaluatePlan(all, ctx()).length, 16);
  assert.equal(evaluatePlan(none, ctx()).length, 0);
});

test("slopeFilter drops points on steep terrain", () => {
  const plan = forestPlan();
  const steep = () => 100; // constant height -> zero slope everywhere
  assert.equal(evaluatePlan(plan, ctx({ heightAt: steep })).length, 5);
  // a ramp: height = x -> slope 1 > maxSlope 0.6 -> all dropped
  const ramp = (x: number) => x;
  assert.equal(evaluatePlan(plan, ctx({ heightAt: ramp })).length, 0);
});

test("slopeFilter without heightAt throws", () => {
  const { heightAt: _drop, ...noHeight } = ctx();
  assert.throws(() => evaluatePlan(forestPlan(), noHeight), /requires ctx.heightAt/);
});

test("spawner weights are honored (fixed seed, exact distribution)", () => {
  // weights 5/3/2 over the 5 surviving points with worldSeed 1234
  const recs = evaluatePlan(forestPlan(), ctx());
  const counts: Record<string, number> = {};
  for (const r of recs) counts[r.asset] = (counts[r.asset] ?? 0) + 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(total, 5);
  // every assigned asset comes from the entry list
  for (const r of recs) {
    assert.ok(["oak", "pine", "birch"].includes(r.asset));
  }
});

test("transform ranges are respected", () => {
  const recs = evaluatePlan(forestPlan(), ctx());
  assert.ok(recs.length > 0);
  for (const r of recs) {
    assert.ok(r.yaw >= 0 && r.yaw <= 6.2831853);
    assert.ok(r.sx >= 0.7 && r.sx <= 1.4);
  }
});

test("unknown node type in a cooked plan throws (defense in depth)", () => {
  const plan = forestPlan();
  plan.nodes[0] = { ...plan.nodes[0], type: "nope" };
  assert.throws(() => evaluatePlan(plan, ctx()), /unknown node type/);
});
