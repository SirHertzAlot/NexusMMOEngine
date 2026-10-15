/**
 * A baked settlement as a scene: one group at the chosen origin with a
 * Structure node per structure, so the server's scene spawner can put the
 * town in the world. The scene is plain data the editor can open.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateScene, worldNodes } from "@mmo-engine/scene";
import { BUILTIN_RULES, generateSettlement, settlementScene } from "../src/index.js";

const r = generateSettlement({ settlementId: "0182", seed: 1234, population: 600 });
if (!r.ok) throw new Error(r.error.message);
const manifest = r.manifest;

describe("settlementScene", () => {
  const scene = settlementScene(manifest, BUILTIN_RULES, { origin: [100, 200] });

  it("is a valid world scene named for the settlement, with a node per structure under one group", () => {
    assert.deepEqual(validateScene(scene), []);
    assert.equal(scene.name, "settlement-0182");
    assert.equal(scene.kind, "world");
    assert.equal(scene.nodes.length, 1);
    assert.equal(scene.nodes[0]!.children!.length, manifest.structures.length);
  });

  it("gives each structure its kind and a footprint that fits inside its parcel", () => {
    const [pw, pd] = BUILTIN_RULES.layout.parcelSizeMm;
    const byId = new Map(manifest.structures.map((s) => [s.id, s]));
    for (const n of scene.nodes[0]!.children!) {
      const c = n.components!.Structure!;
      assert.equal(c.kind, byId.get(n.id)!.archetype);
      assert.ok((c.width as number) < pw / 1000 && (c.depth as number) < pd / 1000);
      assert.ok((c.height as number) > 0);
    }
  });

  it("centres the town on the origin, in metres", () => {
    const at = worldNodes(scene).filter((w) => w.node.components?.Structure);
    const mean = (f: (p: number[]) => number): number => at.reduce((a, w) => a + f(w.position), 0) / at.length;
    assert.ok(Math.abs(mean((p) => p[0]!) - 100) < 40, "x centred near 100");
    assert.ok(Math.abs(mean((p) => p[2]!) - 200) < 40, "z centred near 200");
    assert.equal(new Set(at.map((w) => `${w.position[0]},${w.position[2]}`)).size, at.length, "no two on the same spot");
  });

  it("is the same document for the same settlement", () => {
    assert.deepEqual(settlementScene(manifest, BUILTIN_RULES, { origin: [100, 200] }), scene);
  });

  it("refuses an id a scene cannot be named for", () => {
    const bad = generateSettlement({ settlementId: "Keep One", seed: 1, population: 600 });
    assert.ok(bad.ok);
    assert.throws(() => settlementScene(bad.manifest, BUILTIN_RULES, { origin: [0, 0] }), /name/);
  });
});
