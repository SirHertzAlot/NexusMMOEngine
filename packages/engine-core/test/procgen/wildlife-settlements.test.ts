/** Settlements feed the wildlife planner (docs/WILDLIFE.md): centres from a scene, livestock round them, safe radius round them. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadWildlifeTable, planWildlifeChunk } from "../../src/procgen/wildlife-table.js";
import { sceneSettlements } from "../../src/procgen/wildlife-settlements.js";

const structure = { kind: "house", width: 4, height: 3, depth: 4 };
const scene = {
  version: 1,
  kind: "world",
  name: "town",
  nodes: [
    { id: "a", kind: "group", transform: { position: [100, 0, 200] }, components: { Structure: structure } },
    { id: "b", kind: "group", transform: { position: [140, 0, 200] }, components: { Structure: structure } },
    { id: "c", kind: "group", transform: { position: [120, 0, 240] }, components: { Structure: structure } },
    { id: "t", kind: "group", transform: { position: [0, 0, 0] }, components: {} },
  ],
} as unknown as Parameters<typeof sceneSettlements>[0];

describe("settlements feed the planner", () => {
  it("a scene's Structure nodes are one settlement: centre, count, radius", () => {
    const [s, ...rest] = sceneSettlements(scene);
    assert.equal(rest.length, 0);
    assert.equal(s!.size, 3);
    assert.ok(Math.abs(s!.x - 120) < 1e-9 && Math.abs(s!.z - 213.333333) < 1e-3);
    assert.ok(s!.radius > 20 && s!.radius < 40);
    assert.deepEqual(sceneSettlements({ ...scene, nodes: [] } as typeof scene), []);
  });

  it("with the settlement as a centre, livestock appears round it and nothing dangerous within the safe radius", () => {
    const t = loadWildlifeTable();
    const [s] = sceneSettlements(scene);
    const centres = [{ x: -1e6, z: -1e6, kind: "spawn" as const }, { x: s!.x, z: s!.z, kind: "settlement" as const }];
    const packs: ReturnType<typeof planWildlifeChunk> = [];
    for (let cx = -40; cx < 40; cx++) for (let cz = -40; cz < 40; cz++) packs.push(...planWildlifeChunk(t, { seed: 11, cx, cz, chunkWorldSize: 16, biomeAt: () => "plains", centres }));
    const near = packs.filter((p) => Math.hypot(p.x - s!.x, p.z - s!.z) < t.safeRadiusM);
    assert.ok(near.length > 0, "wildlife near the town");
    assert.ok(near.every((p) => p.tier <= 1), "nothing of tier 2+ inside the safe radius");
    const stock = packs.filter((p) => t.species[p.kind]!.role === "livestock");
    assert.ok(stock.length > 0, "livestock waits at the settlement now");
    for (const c of stock) {
      const d = Math.hypot(c.x - s!.x, c.z - s!.z);
      assert.ok(d >= t.livestock.radiusM[0] && d <= t.livestock.radiusM[1], `${c.kind} ${d | 0} m`);
    }
  });

  it("aquatic packs are flagged so the spawner puts them in water, not out of it", () => {
    const t = loadWildlifeTable();
    const packs: ReturnType<typeof planWildlifeChunk> = [];
    for (let cx = -40; cx < 40; cx++) for (let cz = -40; cz < 40; cz++) packs.push(...planWildlifeChunk(t, { seed: 5, cx, cz, chunkWorldSize: 16, biomeAt: () => "sea", depthAt: () => 10, centres: [{ x: -1e6, z: -1e6, kind: "spawn" }] }));
    assert.ok(packs.length > 0 && packs.every((p) => p.aquatic === (t.species[p.kind]!.habitat === "water")));
    assert.ok(packs.some((p) => p.aquatic));
  });
});
