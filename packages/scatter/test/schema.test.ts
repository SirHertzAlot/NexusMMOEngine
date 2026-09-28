import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseGraphJSON,
  parseInstanceJSON,
  isParamRef,
  PcGraphSchema,
} from "../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const forestJSON = JSON.parse(
  readFileSync(join(here, "..", "..", "examples", "forest.pcg.json"), "utf8"),
);

test("example forest.pcg.json parses", () => {
  const g = parseGraphJSON(forestJSON);
  assert.equal(g.name, "forest");
  assert.equal(g.version, 1);
  assert.equal(g.nodes.length, 6);
  assert.equal(g.edges.length, 5);
  assert.equal(g.params.length, 4);
});

test("rejects wrong version", () => {
  assert.throws(
    () => parseGraphJSON({ ...forestJSON, version: 2 }),
    /unsupported .pcg.json version/,
  );
});

test("rejects empty node list", () => {
  assert.throws(() =>
    parseGraphJSON({ name: "x", version: 1, nodes: [] }),
  );
});

test("rejects node with empty id", () => {
  const bad = {
    name: "x",
    version: 1,
    nodes: [{ id: "", type: "gridSampler", settings: {} }],
  };
  assert.throws(() => parseGraphJSON(bad));
});

test("isParamRef detects { $param } references", () => {
  assert.equal(isParamRef({ $param: "density" }), true);
  assert.equal(isParamRef({ $param: "" }), false);
  assert.equal(isParamRef({ param: "density" }), false);
  assert.equal(isParamRef("density"), false);
  assert.equal(isParamRef(null), false);
  assert.equal(isParamRef(42), false);
  assert.equal(isParamRef([{ $param: "x" }]), false);
});

test("instance parses with defaults", () => {
  const inst = parseInstanceJSON({ graph: "forest" });
  assert.equal(inst.graph, "forest");
  assert.deepEqual(inst.params, {});
});

test("instance parses with overrides", () => {
  const inst = parseInstanceJSON({
    graph: "forest",
    params: { density: 0.9, seed: 42 },
  });
  assert.equal(inst.params.density, 0.9);
});

test("schema is strict about node shape but open on settings", () => {
  // settings values are validated per node type by the cooker, not here
  const g = PcGraphSchema.parse({
    name: "x",
    version: 1,
    nodes: [
      {
        id: "s",
        type: "gridSampler",
        settings: { spacing: { $param: "p" }, anything: [1, 2] },
      },
    ],
  });
  assert.equal(
    (g.nodes[0].settings.anything as unknown[]).length,
    2,
  );
});
