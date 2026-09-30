/**
 * @mmo-engine/picg: linked-subgraph resolution (the hierarchy), graph
 * parameters with per-instance writes, prepareForCook, the PCGM decoder,
 * and the asset library index.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyParameters,
  decodePcgMesh,
  encodePcgMesh,
  definitionIdForGuid,
  exposedParameters,
  fnv1a32,
  parameterValues,
  parseLibraryIndex,
  prepareForCook,
  resolveLinkedSubgraphs,
  sha256Hex,
  SubgraphResolveError,
  variantIndex,
  variantSeed,
  type PcgGraph,
  type PcgSubgraphAsset,
} from "../src/index.js";

const G_BOX = "c0ffee00c0ffee00c0ffee00c0ffee00";
const G_PAIR = "0123456789abcdef0123456789abcdef";
const port = (id: string) => ({ id, name: id, pinType: "SpatialMesh" });

const boxAsset: PcgSubgraphAsset = {
  version: "1.0",
  name: "Box",
  inputs: [],
  outputs: [port("mesh")],
  nodes: [
    { id: "box", type: "CreateBoxMesh", data: { size: 1 } },
    { id: "subgraph_output", type: "SubgraphOutput", data: {} },
  ],
  edges: [{ id: "e", source: "box", target: "subgraph_output", sourceHandle: "out", targetHandle: "mesh", sourcePinType: "SpatialMesh", targetPinType: "SpatialMesh" }],
};

/** A part that links another part twice: a nested hierarchy. */
const pairAsset: PcgSubgraphAsset = {
  version: "1.0",
  name: "Pair",
  inputs: [],
  outputs: [port("mesh")],
  nodes: [
    { id: "a", type: "SubgraphAsset", data: { assetGuid: G_BOX }, subgraphInterface: { inputs: [], outputs: [port("mesh")] } },
    { id: "b", type: "SubgraphAsset", data: { assetGuid: G_BOX }, subgraphInterface: { inputs: [], outputs: [port("mesh")] } },
    { id: "merge", type: "MergeMesh", data: {} },
    { id: "subgraph_output", type: "SubgraphOutput", data: {} },
  ],
  edges: [
    { id: "1", source: "a", target: "merge", sourceHandle: "mesh", targetHandle: "in" },
    { id: "2", source: "b", target: "merge", sourceHandle: "mesh", targetHandle: "in" },
    { id: "3", source: "merge", target: "subgraph_output", sourceHandle: "out", targetHandle: "mesh" },
  ],
};

const library: Record<string, PcgSubgraphAsset> = { [G_BOX]: boxAsset, [G_PAIR]: pairAsset };
const load = (guid: string) => library[guid] ?? null;

function consumer(guid: string, extra: Partial<PcgGraph> = {}): PcgGraph {
  return {
    version: "3.0",
    nodes: [
      { id: "part", type: "SubgraphAsset", data: { assetGuid: guid }, subgraphInterface: { inputs: [], outputs: [port("mesh")] } },
      { id: "output", type: "Output", data: {} },
    ],
    edges: [{ id: "e", source: "part", target: "output", sourceHandle: "mesh", targetHandle: "in", sourcePinType: "SpatialMesh", targetPinType: "SpatialMesh" }],
    parameters: [],
    subgraphs: [],
    ...extra,
  };
}

describe("sha256 / definition ids", () => {
  it("matches known SHA-256 vectors", () => {
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(sha256Hex("a".repeat(200)).length, 64);
  });

  it("gives PICG's definition id for a GUID (hyphens and case don't matter)", () => {
    const id = definitionIdForGuid(G_BOX);
    assert.match(id, /^__ext_[0-9a-f]{16}$/);
    assert.equal(definitionIdForGuid("C0FFEE00-C0FF-EE00-C0FF-EE00C0FFEE00"), id);
  });
});

describe("resolveLinkedSubgraphs", () => {
  it("inlines a linked asset as an embedded definition and instances it", () => {
    const { graph, dependencies } = resolveLinkedSubgraphs(consumer(G_BOX), load);
    assert.equal(graph.version, "2.0");
    assert.deepEqual(dependencies, [G_BOX]);
    const node = graph.nodes.find((n) => n.id === "part")!;
    assert.equal(node.type, "Subgraph");
    assert.equal(node.data?.subgraphId, definitionIdForGuid(G_BOX));
    assert.deepEqual(graph.subgraphs!.map((d) => d.id), [definitionIdForGuid(G_BOX)]);
  });

  it("resolves a hierarchy: a part linking a part, shared once", () => {
    const { graph, dependencies } = resolveLinkedSubgraphs(consumer(G_PAIR), load);
    assert.deepEqual(dependencies, [G_BOX, G_PAIR].sort());
    const pair = graph.subgraphs!.find((d) => d.id === definitionIdForGuid(G_PAIR))!;
    assert.ok(pair.nodes.filter((n) => n.type === "Subgraph").every((n) => n.data?.subgraphId === definitionIdForGuid(G_BOX)));
    assert.equal(graph.subgraphs!.length, 2, "the box definition is embedded once");
  });

  it("fails on missing assets, recursion, and interface drift, naming where", () => {
    assert.throws(() => resolveLinkedSubgraphs(consumer("ffffffffffffffffffffffffffffffff"), load), /Missing or unreadable SubgraphAsset/);
    const loop: PcgSubgraphAsset = { ...pairAsset, nodes: [{ id: "self", type: "SubgraphAsset", data: { assetGuid: G_PAIR }, subgraphInterface: { inputs: [], outputs: [port("mesh")] } }] };
    assert.throws(() => resolveLinkedSubgraphs(consumer(G_PAIR), (g) => (g === G_PAIR ? loop : load(g))), (err: unknown) => err instanceof SubgraphResolveError && /Recursive/.test(err.message));
    const drifted = consumer(G_BOX);
    drifted.nodes[0].subgraphInterface = { inputs: [], outputs: [{ id: "mesh", pinType: "Points" }] };
    assert.throws(() => resolveLinkedSubgraphs(drifted, load), /pinType changed/);
  });
});

describe("parameters", () => {
  const withParams = (): PcgGraph =>
    consumer(G_PAIR, {
      parameters: [
        { id: "p1", name: "Size", type: "number", default: 1, exposed: true, targetNode: "part/a/box", targetProperty: "size", hasRange: true, min: 0.5, max: 4 },
        { id: "p2", name: "Count", type: "integer", default: 3, exposed: false, targetNode: "output", targetProperty: "count" },
      ],
    });

  it("lists the exposed ones and their values", () => {
    const g = withParams();
    assert.deepEqual(exposedParameters(g).map((p) => p.name), ["Size"]);
    assert.deepEqual(parameterValues(g, { Size: 9, Count: 2.6 }), { p1: 4, p2: 3 }, "clamped, rounded");
  });

  it("writes through subgraph instances into a private copy: the other instance keeps its value", () => {
    const { graph } = resolveLinkedSubgraphs(withParams(), load);
    const applied = applyParameters(graph, { p1: 2.5 });
    const pair = applied.subgraphs!.find((d) => d.id.startsWith(definitionIdForGuid(G_PAIR)) && d.id.includes("@part"))!;
    const a = pair.nodes.find((n) => n.id === "a")!;
    const b = pair.nodes.find((n) => n.id === "b")!;
    const boxOf = (id: string) => applied.subgraphs!.find((d) => d.id === id)!.nodes.find((n) => n.id === "box")!;
    assert.equal(boxOf(String(a.data!.subgraphId)).data!.size, 2.5, "instance a changed");
    assert.equal(boxOf(String(b.data!.subgraphId)).data!.size, 1, "instance b untouched");
    assert.equal(boxOf(definitionIdForGuid(G_BOX)).data!.size, 1, "the shared definition untouched");
    assert.equal(graph.subgraphs!.length, 2, "the input graph is not modified");
  });

  it("fails loudly when a parameter targets a missing node", () => {
    const g = consumer(G_BOX, { parameters: [{ id: "x", name: "X", type: "number", default: 1, targetNode: "nope", targetProperty: "size" }] });
    assert.throws(() => applyParameters(g), /target node 'nope' not found/);
  });
});

describe("prepareForCook", () => {
  it("resolves, applies parameters, and drops edge pin-type annotations", () => {
    const { graph, dependencies } = prepareForCook(consumer(G_BOX), { loadSubgraph: load });
    assert.deepEqual(dependencies, [G_BOX]);
    const all = [...graph.edges, ...graph.subgraphs!.flatMap((d) => d.edges)];
    assert.ok(all.every((e) => e.sourcePinType === undefined && e.targetPinType === undefined));
  });

  it("needs a loader only when something is linked", () => {
    assert.throws(() => prepareForCook(consumer(G_BOX)), /no loader/);
    const plain: PcgGraph = { version: "1.0", nodes: [{ id: "o", type: "Output" }], edges: [] };
    assert.equal(prepareForCook(plain).graph.nodes.length, 1);
  });
});

/** Build a PCGM buffer by hand. */
function pcgm(opts: { version: number; normals?: boolean; colors?: boolean; uvs?: boolean; materials?: string[] }): ArrayBuffer {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const indices = [0, 1, 2];
  const flags = (opts.normals ? 1 : 0) | (opts.colors ? 2 : 0) | (opts.uvs ? 4 : 0) | (opts.materials ? 8 : 0);
  const names = (opts.materials ?? []).map((m) => new TextEncoder().encode(m));
  const matBytes = opts.materials ? 4 + names.reduce((a, n) => a + 4 + n.length, 0) + 4 : 0;
  const header = opts.version >= 3 ? 24 : opts.version === 2 ? 20 : 16;
  const size = header + 36 + 12 + (opts.normals ? 36 : 0) + (opts.colors ? 48 : 0) + (opts.uvs ? 24 : 0) + matBytes;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  let o = 0;
  const u32 = (x: number) => { v.setUint32(o, x, true); o += 4; };
  const f32 = (x: number) => { v.setFloat32(o, x, true); o += 4; };
  u32(0x4d474350); u32(opts.version); u32(3); u32(3);
  if (opts.version >= 2) u32(flags);
  if (opts.version >= 3) u32(matBytes);
  positions.forEach(f32);
  indices.forEach(u32);
  if (opts.normals) for (let i = 0; i < 3; i++) { f32(0); f32(0); f32(1); }
  if (opts.colors) for (let i = 0; i < 3; i++) { f32(0.5); f32(0.25); f32(0); f32(1); }
  if (opts.uvs) for (let i = 0; i < 6; i++) f32(i / 6);
  if (opts.materials) {
    u32(names.length);
    for (const n of names) { u32(n.length); new Uint8Array(buf, o, n.length).set(n); o += n.length; }
    u32(names.length - 1);
  }
  return buf;
}

describe("decodePcgMesh", () => {
  it("decodes v2 with every optional block", () => {
    const m = decodePcgMesh(pcgm({ version: 2, normals: true, colors: true, uvs: true }));
    assert.deepEqual([...m.positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual([...m.indices], [0, 1, 2]);
    assert.deepEqual([...m.normals!].slice(0, 3), [0, 0, 1]);
    assert.deepEqual([...m.colors!].slice(0, 4), [0.5, 0.25, 0, 1]);
    assert.equal(m.uvs!.length, 6);
    assert.equal(m.triangleMaterials, null);
  });

  it("decodes v3 material slots (unaligned after the names)", () => {
    const m = decodePcgMesh(pcgm({ version: 3, colors: true, materials: ["bark", "leaves!"] }));
    assert.deepEqual(m.materials, ["bark", "leaves!"]);
    assert.deepEqual([...m.triangleMaterials!], [1]);
  });

  it("rejects bad magic, truncation, and out-of-range indices", () => {
    assert.throws(() => decodePcgMesh(new ArrayBuffer(32)), /bad magic/);
    const full = pcgm({ version: 2, normals: true });
    assert.throws(() => decodePcgMesh(full.slice(0, full.byteLength - 4)), /truncated/);
    const bad = pcgm({ version: 2 });
    new DataView(bad).setUint32(20 + 36 + 8, 7, true);
    assert.throws(() => decodePcgMesh(bad), /out of range/);
  });
});

describe("encodePcgMesh", () => {
  it("writes what decodePcgMesh reads, byte for byte what pcg-core writes", () => {
    const bytes = pcgm({ version: 3, colors: true, materials: ["bark", "leaves!"] });
    const m = decodePcgMesh(bytes);
    assert.deepEqual(Buffer.from(encodePcgMesh(m)), Buffer.from(bytes));
  });

  it("round-trips every optional block, and a plain mesh", () => {
    const mesh = {
      positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1),
      indices: Uint32Array.of(0, 2, 1, 1, 2, 3),
      normals: Float32Array.of(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0),
      colors: new Float32Array(16).fill(0.5),
      uvs: Float32Array.of(0, 0, 1, 0, 0, 1, 1, 1),
      materials: ["floor", "wall"],
      triangleMaterials: Uint32Array.of(0, 1),
    };
    const back = decodePcgMesh(encodePcgMesh(mesh));
    assert.deepEqual(back, { ...mesh });
    const plain = decodePcgMesh(encodePcgMesh({ positions: mesh.positions, indices: mesh.indices }));
    assert.equal(plain.normals, null);
    assert.equal(plain.triangleMaterials, null);
    assert.deepEqual(plain.materials, []);
  });

  it("refuses meshes it can't write", () => {
    const positions = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 0, 1);
    assert.throws(() => encodePcgMesh({ positions, indices: Uint32Array.of(0, 1) }), /triangles/);
    assert.throws(() => encodePcgMesh({ positions, indices: Uint32Array.of(0, 1, 3) }), /out of range/);
    assert.throws(() => encodePcgMesh({ positions, indices: Uint32Array.of(0, 1, 2), normals: new Float32Array(3) }), /normals/);
    assert.throws(() => encodePcgMesh({ positions, indices: Uint32Array.of(0, 1, 2), triangleMaterials: Uint32Array.of(1), materials: ["a"] }), /slot 1/);
  });
});

describe("asset library index", () => {
  it("validates and maps variants to seeds", () => {
    const index = parseLibraryIndex({
      version: 1,
      subgraphs: [{ guid: G_BOX, file: "parts/box.pcgsubgraph" }],
      assets: [{ id: "oak", graph: "trees/oak.pcg", variants: 4 }],
    });
    const oak = index.assets[0];
    assert.equal(variantIndex(oak, 65535), 3);
    assert.notEqual(variantSeed(oak, 0), variantSeed(oak, 1));
    assert.ok(variantSeed(oak, 3) >= 0 && variantSeed(oak, 3) <= 0x7fffffff);
    assert.equal(fnv1a32("oak"), 0xa84bce72, "the AssetRef hash @mmo-engine/scatter gives oak");
  });

  it("rejects malformed indexes with the reason", () => {
    assert.throws(() => parseLibraryIndex({ version: 2, subgraphs: [], assets: [] }), /version/);
    assert.throws(() => parseLibraryIndex({ version: 1, subgraphs: [], assets: [{ id: "a", graph: "g" }, { id: "a", graph: "g" }] }), /duplicate asset id/);
    assert.throws(() => parseLibraryIndex({ version: 1, subgraphs: [{ guid: "XYZ", file: "f" }], assets: [] }), /32 lower-case hex/);
    assert.throws(() => parseLibraryIndex({ version: 1, subgraphs: [], assets: [{ id: "a", graph: "g", variants: 0 }] }), /variants/);
  });
});
