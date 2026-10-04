import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { canonicalGuid } from "@mmo-engine/picg";
import { edgePath, GraphEditor, parseFieldValue, type GraphDocument } from "../src/inspectors/graph-editor.js";
import { listPcgDocuments, validatePcgDocument } from "../src/pcg-host.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const read = (file: string): GraphDocument => JSON.parse(readFileSync(join(repoRoot, "content", "pcg", file), "utf8")) as GraphDocument;
const docs = listPcgDocuments(repoRoot);
const parts = new Map(docs.filter((d) => d.kind === "subgraph").map((d) => [d.guid!, d.file]));

test("the library's documents: every asset graph and every linked part", () => {
  const oak = docs.find((d) => d.file === "trees/oak.pcg");
  assert.equal(oak?.kind, "graph");
  assert.deepEqual(oak?.assets, ["oak"]);
  const trunk = docs.find((d) => d.file === "parts/trunk.pcgsubgraph");
  assert.equal(trunk?.kind, "subgraph");
  assert.equal(trunk?.guid, canonicalGuid("5f0c2d6e8a9b4c1d9e7f3a2b1c0d4e5f"));
});

test("a graph's nodes, pins and edges; a linked part is enterable", () => {
  const ed = new GraphEditor(parts);
  ed.open("trees/oak.pcg", "graph", read("trees/oak.pcg"));
  const vm = ed.viewModel();
  assert.equal(vm.title, "Oak");
  assert.deepEqual(vm.nodes.map((n) => n.id), ["trunk", "crown", "merge", "normals", "output"]);
  const trunk = vm.nodes.find((n) => n.id === "trunk")!;
  assert.equal(trunk.title, "Trunk");
  assert.deepEqual(trunk.outputs, ["mesh"]);
  assert.deepEqual(trunk.enter, { kind: "asset", file: "parts/trunk.pcgsubgraph" });
  assert.deepEqual(vm.nodes.find((n) => n.id === "merge")!.inputs, ["in"]);
  assert.equal(vm.edges.length, 4);
  assert.ok(vm.parameters.some((p) => p.id === "trunk_thickness" && p.editor === "number" && p.range?.[1] === 0.6));
});

test("entering a part needs its document, then the breadcrumb climbs back", () => {
  const ed = new GraphEditor(parts);
  ed.open("trees/oak.pcg", "graph", read("trees/oak.pcg"));
  assert.deepEqual(ed.enter("trunk"), { needs: "parts/trunk.pcgsubgraph" });
  ed.load("parts/trunk.pcgsubgraph", "subgraph", read("parts/trunk.pcgsubgraph"));
  assert.equal(ed.enter("trunk"), null);
  let vm = ed.viewModel();
  assert.equal(vm.file, "parts/trunk.pcgsubgraph");
  assert.deepEqual(vm.crumbs.map((c) => c.label), ["Oak", "Trunk"]);
  assert.ok(vm.nodes.some((n) => n.id === "sweep"));
  assert.deepEqual(vm.parameters, []);
  ed.up(0);
  vm = ed.viewModel();
  assert.equal(vm.file, "trees/oak.pcg");
});

test("embedded definitions are entered within the document", () => {
  const doc: GraphDocument = {
    version: "3.0",
    name: "Nest",
    nodes: [{ id: "inst", type: "Subgraph", data: { subgraphId: "def1" } }],
    edges: [],
    subgraphs: [{ id: "def1", name: "Inner", nodes: [{ id: "a", type: "Box" }], edges: [] }],
  };
  const ed = new GraphEditor(new Map());
  ed.open("x.pcg", "graph", doc);
  ed.enter("inst");
  const vm = ed.viewModel();
  assert.equal(vm.title, "Nest › def1");
  assert.deepEqual(vm.nodes.map((n) => n.id), ["a"]);
  ed.apply({ kind: "move", node: "a", x: 10.4, y: 20.6 });
  assert.deepEqual(ed.pendingSaves()[0].doc.subgraphs![0].nodes[0].position, { x: 10, y: 21 });
});

test("edits are undoable; a drag is one step; saves list dirty documents", () => {
  const ed = new GraphEditor(parts);
  ed.open("trees/oak.pcg", "graph", read("trees/oak.pcg"));
  ed.apply({ kind: "move", node: "merge", x: 150, y: 170 });
  ed.apply({ kind: "move", node: "merge", x: 160, y: 180 });
  ed.endMove();
  ed.select("normals");
  ed.apply({ kind: "setData", node: "normals", key: "cuspAngle", value: 55 });
  ed.apply({ kind: "setParameterDefault", parameter: "trunk_thickness", value: 0.3 });
  let vm = ed.viewModel();
  assert.equal(vm.selected?.properties.find((p) => p.key === "cuspAngle")?.value, 55);
  assert.equal(vm.parameters.find((p) => p.id === "trunk_thickness")?.value, 0.3);
  assert.ok(vm.dirty);
  assert.deepEqual(vm.dirtyFiles, ["trees/oak.pcg"]);
  ed.undo();
  ed.undo();
  vm = ed.viewModel();
  assert.equal(vm.selected?.properties.find((p) => p.key === "cuspAngle")?.value, 40);
  assert.equal(vm.nodes.find((n) => n.id === "merge")?.x, 160);
  ed.undo();
  assert.equal(ed.viewModel().nodes.find((n) => n.id === "merge")?.x, 140);
  assert.equal(ed.viewModel().dirty, false);
  ed.redo();
  assert.equal(ed.viewModel().nodes.find((n) => n.id === "merge")?.x, 160);
  ed.markSaved("trees/oak.pcg");
  assert.equal(ed.viewModel().dirty, false);
  ed.apply({ kind: "deleteData", node: "normals", key: "shadeMode" });
  ed.revert("trees/oak.pcg");
  ed.select("normals");
  assert.ok(ed.viewModel().selected?.properties.some((p) => p.key === "shadeMode"));
});

test("saves are validated the way the server cooks", () => {
  assert.deepEqual(validatePcgDocument(repoRoot, "trees/oak.pcg", read("trees/oak.pcg")), []);
  assert.deepEqual(validatePcgDocument(repoRoot, "parts/trunk.pcgsubgraph", read("parts/trunk.pcgsubgraph")), []);
  // An edge to nowhere.
  const bad = read("trees/oak.pcg");
  bad.edges.push({ id: "x", source: "merge", target: "ghost" });
  assert.match(validatePcgDocument(repoRoot, "trees/oak.pcg", bad)[0].message, /'ghost' is not a node/);
  // Renaming a part's node breaks the trees whose parameters target it.
  const trunk = read("parts/trunk.pcgsubgraph");
  trunk.nodes.find((n) => n.id === "sweep")!.id = "sweep2";
  for (const e of trunk.edges) {
    if (e.source === "sweep") e.source = "sweep2";
    if (e.target === "sweep") e.target = "sweep2";
  }
  const issues = validatePcgDocument(repoRoot, "parts/trunk.pcgsubgraph", trunk);
  assert.ok(issues.length >= 3, JSON.stringify(issues)); // oak, birch, pine
  assert.ok(issues.every((i) => /trunk\/sweep/.test(i.message)), JSON.stringify(issues));
  // Only library documents.
  assert.throws(() => validatePcgDocument(repoRoot, "../rules/loot.json", {}), /not a PICG library document/);
});

test("field values parse by editor kind", () => {
  assert.equal(parseFieldValue("number", "1.5"), 1.5);
  assert.throws(() => parseFieldValue("number", "abc"));
  assert.throws(() => parseFieldValue("number", " "));
  assert.equal(parseFieldValue("boolean", "true"), true);
  assert.deepEqual(parseFieldValue("json", "[1,2]"), [1, 2]);
  assert.throws(() => parseFieldValue("json", "[1,"));
  assert.match(edgePath(0, 0, 10, 100), /^M 0 0 C 0 50, 10 50, 10 100$/);
});
