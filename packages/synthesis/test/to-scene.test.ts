import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateScene } from "@mmo-engine/scene";
import { synthesizeAssembly, synthesisToScene } from "../src/index.js";

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
});
