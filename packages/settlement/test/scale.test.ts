/**
 * Building scale: parcels and streets follow the factor (streets never below
 * 2 m), the manifest records it, the scene stays authored at scale 1 yet fits
 * the scaled parcel once the spawner applies the factor, and the report flags
 * models that overflow.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCALE, type ScaleDoc } from "@mmo-engine/scene";
import { BUILTIN_RULES, MIN_STREET_MM, generateSettlement, layOut, scaleReport, settlementScene, streams, type CatalogModel } from "../src/index.js";

const [pw, pd] = BUILTIN_RULES.layout.parcelSizeMm;

describe("layOut at a building scale", () => {
  it("scales parcels and streets, and keeps a street at least 2 m wide", () => {
    const l = layOut("0182", 136, BUILTIN_RULES, streams(1), 0.5);
    assert.equal(l.parcels[0]!.areaM2, (pw * 0.5 * pd * 0.5) / 1e6);
    assert.equal(l.roads.edges[0]!.widthMm, BUILTIN_RULES.layout.streetWidthMm * 0.5);
    const tiny = layOut("0182", 136, BUILTIN_RULES, streams(1), 0.1);
    assert.ok(tiny.roads.edges.every((e) => e.widthMm === MIN_STREET_MM));
  });
});

describe("a baked town at scale", () => {
  const bake = (scale: number) => {
    const r = generateSettlement({ settlementId: "0182", seed: 1234, population: 600, scale });
    if (!r.ok) throw new Error(r.error.message);
    return r.manifest;
  };
  it("records the scale, and a different scale is a different town", () => {
    assert.equal(bake(0.6).scale, 0.6);
    assert.notEqual(bake(0.6).hash, bake(1).hash);
  });
  it("rejects a non-positive scale", () => {
    assert.equal(generateSettlement({ settlementId: "x", seed: 1, population: 10, scale: 0 }).ok, false);
  });
  for (const f of [0.6, 1, 2]) {
    it(`scene footprint x ${f} fits the scaled parcel with a 1 m margin; heights stay authored`, () => {
      const m = bake(f);
      const scene = settlementScene(m, BUILTIN_RULES, { origin: [0, 0] });
      for (const n of scene.nodes[0]!.children!) {
        const c = n.components!.Structure!;
        assert.ok((c.width as number) * f + 2 <= (pw * f) / 1000 + 1e-9);
        assert.ok((c.depth as number) * f + 2 <= (pd * f) / 1000 + 1e-9);
        assert.equal(c.height, BUILTIN_RULES.archetypes[c.kind as string]!.heightM);
      }
    });
  }
});

describe("scaleReport", () => {
  const models: CatalogModel[] = [
    { id: "p/Big_House", name: "Big_House", skinned: false, size: [30, 8, 10] },
    { id: "p/Small_House", name: "Small_House", skinned: false, size: [8, 6, 8] },
  ];
  const doc: ScaleDoc = { ...DEFAULT_SCALE, categories: { building: 0.6 } };
  it("gives before, after and the parcel, and flags overflow", () => {
    const rows = scaleReport(models, { house: ["_House$"] }, doc, BUILTIN_RULES);
    const big = rows.find((r) => r.model === "p/Big_House")!;
    assert.deepEqual(big.after, [18, 4.8, 6]);
    assert.deepEqual(big.parcel, [7.2, 12]);
    assert.equal(big.overflow, true);
    assert.equal(rows.find((r) => r.model === "p/Small_House")!.overflow, false);
  });
  it("applies a per-asset factor on top", () => {
    const rows = scaleReport(models, { house: ["Small"] }, { ...doc, assets: { "p/Small*": 0.5 } }, BUILTIN_RULES);
    assert.equal(rows[0]!.factor, 0.3);
  });
});
