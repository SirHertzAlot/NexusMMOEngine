/**
 * Pure parts of the scene viewport (EA5): terrain snapping, node markers,
 * and what a picked node publishes to the shared selection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHeightSampler, markerFor, nodeSelection, placeableKind } from "../src/viewport-model.js";

const flat = (cx: number, cz: number, h: (i: number, j: number) => number) => ({
  cx,
  cz,
  heights: Float32Array.from({ length: 256 }, (_, v) => h(v % 16, Math.floor(v / 16))),
});

describe("makeHeightSampler", () => {
  it("reads the tile height and interpolates between samples", () => {
    // Height rises 1 m per sample along x: at chunk size 15 a sample is 1 m.
    const at = makeHeightSampler([flat(0, 0, (i) => i)], 15);
    assert.equal(at(0, 0), 0);
    assert.equal(at(3, 7), 3);
    assert.ok(Math.abs(at(3.5, 7)! - 3.5) < 1e-6);
  });
  it("picks the right chunk, handles negatives, and is null off the map", () => {
    const at = makeHeightSampler([flat(0, 0, () => 1), flat(-1, 0, () => 5)], 16);
    assert.equal(at(8, 8), 1);
    assert.equal(at(-8, 8), 5);
    assert.equal(at(100, 100), null);
    assert.equal(at(Number.NaN, 0), null);
  });
});

describe("markerFor", () => {
  it("shapes by node kind and colours prefabs by what they are", () => {
    assert.equal(markerFor({ id: "a", kind: "spawn-point" }, new Set(["goblin"])).shape, "cone");
    assert.equal(markerFor({ id: "a", kind: "group" }, new Set()).shape, "octahedron");
    const sp = markerFor({ id: "a", prefab: "goblin" }, new Set(["goblin"]));
    const prop = markerFor({ id: "a", prefab: "oak" }, new Set(["goblin"]));
    assert.equal(sp.shape, "box");
    assert.notEqual(sp.color, prop.color);
    assert.equal(markerFor({ id: "a", prefab: "camps/goblin" }, new Set(["goblin"])).color, sp.color, "last path segment counts");
  });
});

describe("nodeSelection", () => {
  it("describes a node for the shared selection", () => {
    const s = nodeSelection("viewport", { id: "camp", name: "Goblin camp", prefab: "camps/goblin", transform: { position: [1, 2, 3] }, components: { Spawner: { creature: "goblin" } } });
    assert.equal(s.kind, "scene-node");
    assert.equal(s.source, "viewport");
    assert.equal(s.id, "camp");
    assert.equal(s.label, "Goblin camp");
    assert.deepEqual(s.components.map((c) => c.name), ["Transform", "Spawner"]);
    assert.deepEqual(s.components[0].fields[0], { key: "position", value: "1, 2, 3" });
  });
});

describe("placeableKind", () => {
  it("tells species from props and PICG assets", () => {
    const p = { species: [{ id: "goblin", label: "Goblin" }], props: [{ id: "oak", label: "oak" }], pcg: [{ id: "birch", label: "Birch" }] };
    assert.equal(placeableKind(p, "goblin"), "species");
    assert.equal(placeableKind(p, "oak"), "prop");
    assert.equal(placeableKind(p, "birch"), "pcg");
    assert.equal(placeableKind(p, "x"), null);
  });
});
