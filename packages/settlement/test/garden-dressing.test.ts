/**
 * Gardens and churchyards in the settlement scene (village synthesis): dressed as formal gardens, never as buildings.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GardenModels } from "@mmo-engine/synthesis";
import { BUILTIN_RULES, generateSettlement, settlementScene } from "../src/index.js";

const MODELS: GardenModels = {
  planter: { id: "p/Planter", size: [2.1, 0.7, 0.8] },
  plants: [{ id: "p/Flower", size: [0.9, 0.9, 0.8] }],
  trees: [{ id: "p/Tree", size: [1.2, 2.5, 1] }],
  stones: [{ id: "p/Stone", size: [0.8, 1.3, 0.3] }],
};

const r = generateSettlement({ settlementId: "0001", seed: 1234, population: 668 });
if (!r.ok) throw new Error(r.error.message);
const manifest = r.manifest;

describe("garden dressing in the scene", () => {
  const kids = (scene: ReturnType<typeof settlementScene>) => scene.nodes[0]!.children!;
  it("turns every garden and churchyard into a dressed ground group of planters, plants and trees (or headstones)", () => {
    const scene = settlementScene(manifest, BUILTIN_RULES, { origin: [0, 0], gardens: MODELS });
    const grounds = kids(scene).filter((n) => /^grounds:/.test(n.name ?? ""));
    const open = manifest.structures.filter((s) => s.archetype === "garden" || s.archetype === "churchyard");
    assert.equal(grounds.length, open.length);
    assert.ok(grounds.length > 0);
    for (const g of grounds) {
      const parts = new Set((g.children ?? []).map((c) => (c.components!.Structure as { kind: string }).kind));
      assert.ok(parts.has("garden_path") && parts.has("garden_tree"), `${g.id}: a path and trees`);
      assert.ok(parts.has(g.name === "grounds:garden" ? "garden_planter" : "garden_stone") || (g.children ?? []).length <= 4, `${g.id}: its beds or headstones`);
    }
  });

  it("leaves a garden a plain open box when there are no models, and builds nothing else out of it", () => {
    const scene = settlementScene(manifest, BUILTIN_RULES, { origin: [0, 0] });
    assert.equal(kids(scene).filter((n) => /^grounds:/.test(n.name ?? "")).length, 0);
    const g = kids(scene).find((n) => n.name === "garden")!;
    assert.equal((g.components!.Structure as { kind: string }).kind, "garden");
  });
});
