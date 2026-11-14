import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateScene } from "@mmo-engine/scene";
import { buildingToSceneNodes, synthesizeAssembly, synthesisToScene, yawDegrees } from "../src/index.js";

const ruleSet = JSON.parse(readFileSync(join(process.cwd(), "..", "..", "content", "synthesis", "dungeon-rules.json"), "utf8"));

describe("synthesisToScene", () => {
  it("turns each placed part into a Structure node the scene validator accepts", () => {
    const out = synthesizeAssembly({
      ruleSet,
      seed: 9913,
      site: { bounds: { min: [-22, 0, -22], max: [22, 14, 22] } },
      blueprint: { archetype: "multi-level-descent" },
      budget: { maxParts: 40, maxGrowthAttempts: 600 },
    });
    const doc = synthesisToScene(out, { name: "t-room" });
    assert.equal(doc.nodes.length, out.placements.length);
    assert.deepEqual(validateScene(doc), []);
    const first = out.placements[0];
    assert.deepEqual(doc.nodes[0].transform?.position, first.transform.pos);
    assert.equal(doc.nodes[0].components?.Structure?.kind, first.category || first.partId);
  });

  it("names an art model for a part whose asset is mapped, a stand-in box otherwise", () => {
    const out = synthesizeAssembly({
      ruleSet,
      seed: 9913,
      site: { bounds: { min: [-22, 0, -22], max: [22, 14, 22] } },
      blueprint: { archetype: "multi-level-descent" },
      budget: { maxParts: 10, maxGrowthAttempts: 200 },
    });
    const ref = out.placements[0].assetRef;
    const doc = synthesisToScene(out, { name: "t-room", assets: { [ref]: "catalog-model" } });
    assert.equal(doc.nodes[0].components?.Structure?.asset, "catalog-model");
    assert.equal(doc.nodes[1].components?.Structure?.asset, out.placements[1].assetRef === ref ? "catalog-model" : "");
  });

  it("keeps a part's tilt on its node, and gives its box in the yaw's axes", () => {
    // A post modelled upright (0.2 x 2.5 x 0.2, pivot at its foot) laid on its side: yawed 90, then rolled 90 about Z.
    const s = Math.SQRT1_2;
    const rot: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5]; // (0, s, 0, s) * (0, 0, s, s)
    const bounds = { min: [-0.1, 0, -0.1] as [number, number, number], max: [0.1, 2.5, 0.1] as [number, number, number], size: [0.2, 2.5, 0.2] as [number, number, number] };
    const post = (r: [number, number, number, number]) => ({ partId: "Post", assetRef: "kit/Post", category: "beam", size: [0.2, 2.5, 0.2] as [number, number, number], pivotBounds: bounds, colliderMode: "solid" as const, transform: { pos: [0, 3, 0] as [number, number, number], rot: r, scale: [1, 1, 1] as [number, number, number] } });
    const g = buildingToSceneNodes({ archetype: "house", placements: [post(rot), post([0, s, 0, s])] }, { id: "b", archetype: "house" });
    const laid = g.children!.find((c) => c.id === "b-vis-0")!;
    const upright = g.children!.find((c) => c.id === "b-vis-1")!;
    assert.deepEqual(laid.transform?.rotation, [0, 90, 90], "pitch 0, yaw 90, roll 90");
    const st = laid.components!.Structure!;
    // Rolled 90 about Z its length runs along -X of its yaw frame from the pivot: 2.5 long, 0.2 high, its middle 1.25 out.
    assert.deepEqual([st.width, st.height, st.depth], [2.5, 0.2, 0.2]);
    assert.deepEqual([st.centreX, st.centreY, st.centreZ], [-1.25, 0, 0]);
    const col = g.children!.find((c) => c.id === "b-p0-col")!;
    assert.deepEqual([col.components!.Collider!.hx, col.components!.Collider!.hy], [1.25, 0.1], "its collider lies down too");
    assert.deepEqual(upright.transform?.rotation, [0, 90, 0], "an untilted part keeps a yaw-only rotation");
    assert.deepEqual([upright.components!.Structure!.width, upright.components!.Structure!.height], [0.2, 2.5]);
  });

  it("reads a part's yaw from its quaternion, and keeps it on the node", () => {
    const quarter = Math.SQRT1_2; // 90 degrees about +Y
    assert.ok(Math.abs(yawDegrees([0, quarter, 0, quarter]) - 90) < 1e-9);
    assert.ok(Math.abs(yawDegrees([0, 0, 0, 1])) < 1e-9);
  });

  it("sizes each Structure from the part's size in metres, not its scale", () => {
    const out = synthesizeAssembly({
      ruleSet,
      seed: 9913,
      site: { bounds: { min: [-22, 0, -22], max: [22, 14, 22] } },
      blueprint: { archetype: "multi-level-descent" },
      budget: { maxParts: 10, maxGrowthAttempts: 200 },
    });
    const doc = synthesisToScene(out, { name: "t-room" });
    const [w, h, d] = out.placements[0].size;
    const structure = doc.nodes[0].components?.Structure;
    assert.equal(structure?.width, Math.round(Math.abs(w) * 1000) / 1000);
    assert.equal(structure?.height, Math.round(Math.abs(h) * 1000) / 1000);
    assert.equal(structure?.depth, Math.round(Math.abs(d) * 1000) / 1000);
  });
});
