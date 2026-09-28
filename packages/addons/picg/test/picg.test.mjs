// addon-picg: pcg-core cooks graphs into PCGM meshes off the calling
// thread, deterministically per seed, one at a time; invalid graphs and
// the compiled-out mesh import fail with pcg-core's own messages.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const picg = require("../index.js");

const edge = (id, source, target) => ({ id, source, target, sourceHandle: "out", targetHandle: "in" });
const box = {
  version: "1.0",
  nodes: [
    { id: "box", type: "CreateBoxMesh", position: { x: 0, y: 0 }, data: {} },
    { id: "out", type: "Output", position: { x: 0, y: 100 }, data: {} },
  ],
  edges: [edge("e1", "box", "out")],
  parameters: [],
  subgraphs: [],
};
const staircase = readFileSync(new URL("./fixtures/spiral-staircase.pcg", import.meta.url), "utf8");

/** PCGM header fields (see pcg_api.h). */
function header(mesh) {
  const v = new DataView(mesh);
  return { magic: String.fromCharCode(...new Uint8Array(mesh, 0, 4)), version: v.getUint32(4, true), vertices: v.getUint32(8, true), indices: v.getUint32(12, true) };
}

test("reports the pcg-core runtime version", () => {
  assert.match(picg.version(), /^pcg-core \d+\.\d+\.\d+/);
});

test("validate: null for a valid graph, pcg-core's message otherwise", () => {
  assert.equal(picg.validate(box), null);
  assert.match(picg.validate("{"), /parse error/);
  assert.match(
    picg.validate({ version: "1.0", nodes: [{ id: "x", type: "NoSuchNode", data: {} }], edges: [] }),
    /Unknown node type: "NoSuchNode"/,
  );
});

test("cooks a box into a PCGM mesh", async () => {
  const r = await picg.cook(box, 1);
  assert.equal(r.kind, "mesh");
  assert.deepEqual([r.vertexCount, r.indexCount], [24, 36], "6 faces x 4 vertices, 12 triangles");
  const h = header(r.mesh);
  assert.equal(h.magic, "PCGM");
  assert.deepEqual([h.vertices, h.indices], [24, 36]);
});

test("a real example graph cooks the same bytes for the same seed", async () => {
  const a = await picg.cook(staircase, 1234);
  picg.clearCache();
  const b = await picg.cook(staircase, 1234);
  assert.equal(a.kind, "mesh");
  assert.ok(a.vertexCount > 1000, `${a.vertexCount} vertices`);
  assert.deepEqual(new Uint8Array(a.mesh), new Uint8Array(b.mesh));
});

test("cooks run one at a time and all complete, in order", async () => {
  const done = [];
  await Promise.all([
    picg.cook(staircase, 1).then(() => done.push("staircase")),
    picg.cook(box, 2).then(() => done.push("box")),
    picg.cook("{", 3).catch(() => done.push("bad")),
    picg.cook(box, 4).then(() => done.push("box2")),
  ]);
  assert.deepEqual(done, ["staircase", "box", "bad", "box2"]);
});

test("invalid graphs reject with pcg-core's message", async () => {
  await assert.rejects(picg.cook({ version: "1.0", nodes: [{ id: "x", type: "NoSuchNode", data: {} }], edges: [] }), /Unknown node type/);
});

test("mesh-file import is compiled out and says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "picg-"));
  const obj = join(dir, "tri.obj");
  writeFileSync(obj, "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
  const graph = {
    version: "1.0",
    nodes: [
      { id: "m", type: "ImportMesh", data: { path: obj } },
      { id: "out", type: "Output", data: {} },
    ],
    edges: [edge("e", "m", "out")],
  };
  await assert.rejects(picg.cook(graph, 1), /needs a build with Assimp/);
});
