import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseGraphJSON, type PcGraph } from "../src/schema.js";
import { cook, stableStringify } from "../src/cooker.js";

const here = dirname(fileURLToPath(import.meta.url));
const forestJSON = JSON.parse(
  readFileSync(join(here, "..", "..", "examples", "forest.pcg.json"), "utf8"),
);
const forest = (): PcGraph =>
  parseGraphJSON(JSON.parse(JSON.stringify(forestJSON)));

test("cooks the example forest graph", () => {
  const plan = cook(forest());
  assert.equal(plan.planVersion, 1);
  assert.equal(plan.graphName, "forest");
  assert.match(plan.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(plan.order, [
    "sample",
    "thin",
    "flat",
    "tag",
    "vary",
    "spawn",
  ]);
  assert.equal(plan.spawner, "spawn");
  // params resolved to defaults
  assert.equal(plan.params.density, 0.35);
  assert.equal(plan.params.spacing, 4);
  // $param refs substituted in node settings
  const sample = plan.nodes.find((n) => n.id === "sample")!;
  assert.equal(sample.settings.spacing, 4);
  assert.equal(sample.settings.seed, 1337);
});

test("cooking is deterministic: same input -> same hash", () => {
  const a = cook(forest());
  const b = cook(forest());
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a, b);
});

test("instance param overrides change the plan hash", () => {
  const base = cook(forest());
  const over = cook(forest(), {
    graph: "forest",
    params: { density: 0.9 },
  });
  assert.notEqual(over.hash, base.hash);
  assert.equal(over.params.density, 0.9);
  const thin = over.nodes.find((n) => n.id === "thin")!;
  assert.equal(thin.settings.density, 0.9);
});

test("instance targeting another graph is rejected", () => {
  assert.throws(
    () => cook(forest(), { graph: "desert", params: {} }),
    /targets graph "desert" but got "forest"/,
  );
});

test("instance overriding an unknown param is rejected", () => {
  assert.throws(
    () => cook(forest(), { graph: "forest", params: { nope: 1 } }),
    /unknown param "nope"/,
  );
});

test("instance param with wrong type is rejected", () => {
  assert.throws(
    () => cook(forest(), { graph: "forest", params: { density: "high" } }),
    /must be number/,
  );
});

test("unknown node type is rejected", () => {
  const g = forest();
  g.nodes.push({ id: "x", type: "frobnicator", settings: {} });
  assert.throws(() => cook(g), /unknown type "frobnicator"/);
});

test("duplicate node ids are rejected", () => {
  const g = forest();
  g.nodes.push({ id: "sample", type: "densityFilter", settings: {} });
  assert.throws(() => cook(g), /duplicate node id "sample"/);
});

test("unknown $param reference is rejected", () => {
  const g = forest();
  (g.nodes[0].settings as Record<string, unknown>).spacing = {
    $param: "nope",
  };
  assert.throws(() => cook(g), /references unknown param "nope"/);
});

test("invalid setting value is rejected", () => {
  const g = forest();
  (g.nodes[1].settings as Record<string, unknown>).density = 1.5;
  assert.throws(() => cook(g), /invalid settings for node type "densityFilter"/);
});

test("unknown setting key is rejected (strict)", () => {
  const g = forest();
  (g.nodes[1].settings as Record<string, unknown>).bogus = 1;
  assert.throws(() => cook(g), /invalid settings for node type "densityFilter"/);
});

test("edge to unknown node is rejected", () => {
  const g = forest();
  g.edges.push({ from: "spawn", to: "ghost" });
  assert.throws(() => cook(g), /edge to unknown node "ghost"/);
});

test("self-edge is rejected", () => {
  const g = forest();
  g.edges.push({ from: "thin", to: "thin" });
  assert.throws(() => cook(g), /self-edge/);
});

test("a disconnected cycle is rejected (not on sampler→spawner path)", () => {
  // With the indegree-1 pin rule, a cycle can only exist as a component
  // disconnected from the main chain; reachability rejects it before the
  // Kahn cycle check (which remains as defense-in-depth).
  const g = forest();
  g.nodes.push(
    { id: "ca", type: "densityFilter", settings: { density: 0.5, seed: 1 } },
    { id: "cb", type: "densityFilter", settings: { density: 0.5, seed: 2 } },
  );
  g.edges.push({ from: "ca", to: "cb" }, { from: "cb", to: "ca" });
  assert.throws(() => cook(g), /not on a sampler→spawner path/);
});

test("dead branch (not on sampler->spawner path) is rejected", () => {
  const g = forest();
  g.nodes.push({
    id: "lonely",
    type: "densityFilter",
    settings: { density: 0.5, seed: 1 },
  });
  g.edges.push({ from: "sample", to: "lonely" });
  assert.throws(() => cook(g), /not on a sampler→spawner path/);
});

test("disconnected node is rejected", () => {
  const g = forest();
  g.nodes.push({
    id: "island",
    type: "setAttribute",
    settings: { attribute: "x", value: 1 },
  });
  // no edges at all for island -> indegree != 1
  assert.throws(() => cook(g), /must have exactly one input/);
});

test("graph without a spawner is rejected", () => {
  const g = forest();
  g.nodes = g.nodes.filter((n) => n.type !== "meshSpawner");
  g.edges = g.edges.filter((e) => e.to !== "spawn");
  assert.throws(() => cook(g), /no spawner/);
});

test("two spawners are rejected", () => {
  const g = forest();
  g.nodes.push({
    id: "spawn2",
    type: "meshSpawner",
    settings: { entries: [{ asset: "oak", weight: 1 }], seed: 5 },
  });
  g.edges.push({ from: "vary", to: "spawn2" });
  assert.throws(() => cook(g), /exactly one spawner/);
});

test("two samplers are rejected", () => {
  const g = forest();
  g.nodes.push({
    id: "sample2",
    type: "gridSampler",
    settings: { spacing: 4, jitter: 0, seed: 9 },
  });
  g.edges.push({ from: "sample2", to: "thin" });
  // thin would then have two inputs; sampler-count check fires first
  assert.throws(() => cook(g), /exactly one sampler|exactly one input/);
});

test("sampler with an input is rejected", () => {
  const g = forest();
  g.edges.push({ from: "thin", to: "sample" });
  assert.throws(() => cook(g), /must have no inputs/);
});

test("stableStringify sorts keys recursively", () => {
  const a = stableStringify({ z: 1, a: { y: 2, b: 3 } });
  const b = stableStringify({ a: { b: 3, y: 2 }, z: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"b":3,"y":2},"z":1}');
});
