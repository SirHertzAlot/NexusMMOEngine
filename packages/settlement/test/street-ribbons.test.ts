/**
 * Street ribbons (SG2b): a routed paved street becomes a ribbon whose centreline is the router's path and whose rails sit
 * half its width either side, and the bake writes them beside the scene.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bakeSettlement, BUILTIN_RULES, generateSettlement, settlementScene, streetRibbon, streetRibbons, type SettlementRequest } from "../src/index.js";

const origin: [number, number] = [100, 200];
const base: SettlementRequest = { settlementId: "0182", seed: 1234, population: 600 };

/** A router that bends every street through a point 3 m to the side of its midpoint, rising 1 m at the far end. */
const bend = (from: [number, number], to: [number, number]) => {
  const mid = [(from[0] + to[0]) / 2 + 0.003, (from[1] + to[1]) / 2];
  return [
    { x: from[0], z: from[1], h: 0 },
    { x: mid[0]!, z: mid[1]!, h: 0.5 },
    { x: to[0], z: to[1], h: 1 },
  ];
};

const routed = generateSettlement({ ...base, site: { origin, dry: () => true, route: bend } });
if (!routed.ok) throw new Error("the town must generate");

describe("street ribbons", () => {
  it("a straight street: rails lie half its width either side of the centreline, at the path's heights", () => {
    const r = streetRibbon({ id: "s", roadClass: "street", widthMm: 4000 }, [
      { x: 0, z: 0, h: 0 },
      { x: 2000, z: 0, h: 0.5 },
      { x: 4000, z: 0, h: 1 },
    ])!;
    assert.equal(r.widthM, 4);
    assert.equal(r.center.length, 9);
    for (let i = 0; i < 3; i++) {
      const [cx, cy, cz] = [r.center[i * 3]!, r.center[i * 3 + 1]!, r.center[i * 3 + 2]!];
      const [lx, ly, lz] = [r.left[i * 3]!, r.left[i * 3 + 1]!, r.left[i * 3 + 2]!];
      const [rx, ry, rz] = [r.right[i * 3]!, r.right[i * 3 + 1]!, r.right[i * 3 + 2]!];
      assert.equal(cy, ly);
      assert.equal(cy, ry);
      assert.ok(Math.abs(lx - cx) < 1e-9 && Math.abs(rx - cx) < 1e-9, "rails sit across the street, not along it");
      assert.ok(Math.abs(Math.abs(lz - cz) - 2) < 1e-9 && Math.abs(Math.abs(rz - cz) - 2) < 1e-9, "each rail is 2 m from the centre");
      assert.ok(Math.abs(lz - cz + (rz - cz)) < 1e-9, "the rails are on opposite sides");
    }
  });

  it("a bent street: each rail is one width from the other at every sample", () => {
    const r = streetRibbon({ id: "b", roadClass: "street", widthMm: 3000 }, bend([0, 0], [6000, 0]))!;
    for (let i = 0; i < 3; i++) {
      const dx = r.left[i * 3]! - r.right[i * 3]!;
      const dz = r.left[i * 3 + 2]! - r.right[i * 3 + 2]!;
      assert.ok(Math.abs(Math.hypot(dx, dz) - 3) < 1e-9, `sample ${i} is 3 m across`);
    }
  });

  it("a street with fewer than two points, or no width, has no ribbon", () => {
    assert.equal(streetRibbon({ id: "x", roadClass: "street", widthMm: 3000 }, [{ x: 0, z: 0, h: 0 }]), null);
    assert.equal(streetRibbon({ id: "x", roadClass: "street", widthMm: 0 }, bend([0, 0], [6000, 0])), null);
  });

  it("the town has one ribbon per routed paved street, and none for the unrouted ones", () => {
    const paved = routed.manifest.roads.edges.filter((e) => e.surface === "paved");
    const ribbons = streetRibbons(routed.manifest);
    assert.equal(ribbons.length, paved.length, "every paved street is routed in this town");
    assert.deepEqual(ribbons.map((r) => r.edgeId).sort(), paved.map((e) => e.id).sort());
    for (const r of ribbons) {
      const e = paved.find((x) => x.id === r.edgeId)!;
      assert.equal(r.center.length, e.path!.length * 3, `${r.edgeId} has a sample per path point`);
      assert.equal(r.center[0], e.path![0]!.x / 1000, `${r.edgeId} starts on its path`);
      assert.equal(r.center[1], e.path![0]!.h);
    }
  });

  it("the bake writes the ribbons beside the scene", () => {
    const dir = mkdtempSync(join(tmpdir(), "ribbons-"));
    try {
      const scene = join(dir, "scenes");
      const bake = (request: SettlementRequest) => bakeSettlement(request, join(dir, "out"), { scene: { dir: scene, origin } });
      const r = bake({ ...base, site: { origin, dry: () => true, route: bend } });
      assert.ok(r.ok);
      const file = JSON.parse(readFileSync(join(scene, "settlement-0182.ribbons.json"), "utf8")) as { scene: string; streets: unknown[] };
      assert.equal(file.scene, "settlement-0182");
      assert.equal(file.streets.length, streetRibbons(routed.manifest).length);
      const s = settlementScene(routed.manifest, BUILTIN_RULES, { origin });
      assert.ok(s.nodes[0]!.children!.some((n) => n.id.startsWith("paving-")), "the scene keeps its slabs for the server");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
