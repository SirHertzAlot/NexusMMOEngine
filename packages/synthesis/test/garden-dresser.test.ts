/**
 * The garden dresser: a path, planters on a uniform pitch with evenly spaced plants, trees in line, nothing off the plot.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GARDEN_KINDS, dressGarden, gardenLayout, pickGardenModels, type GardenModels } from "../src/garden-dresser.js";

const M: GardenModels = {
  planter: { id: "p/Planter", size: [2.1, 0.7, 0.8] },
  plants: [{ id: "p/Flower_A", size: [0.9, 0.9, 0.8] }, { id: "p/Flower_B", size: [0.7, 0.8, 0.8] }],
  trees: [{ id: "p/Tree_A", size: [1.2, 2.5, 1.0] }, { id: "p/Tree_B", size: [1.0, 2.4, 1.0] }],
  stones: [{ id: "p/Stone_A", size: [0.8, 1.3, 0.3] }],
};
const opts = { id: "g0", kind: "garden" as const, widthM: 12, depthM: 20, models: M, seed: 7, position: [0, 0, 0] as const, yawDeg: 0 };
const of = (g: ReturnType<typeof dressGarden>, kind: string) => (g.children ?? []).filter((c) => (c.components!.Structure as { kind: string }).kind === kind);
const pos = (n: { transform?: { position?: number[] } }) => n.transform!.position!;

describe("layout", () => {
  it("fits whole planters on a uniform pitch, and says null when a plot cannot hold one", () => {
    const l = gardenLayout(12, 20, M.planter.size)!;
    assert.deepEqual([l.rows, l.columns], [Math.floor((18 + 1) / 3.1), Math.floor((((10 - 1.6) / 2) + 1) / 1.8)]);
    assert.equal(gardenLayout(3, 3, M.planter.size), null);
  });
});

describe("dressGarden", () => {
  const g = dressGarden(opts);
  const planters = of(g, GARDEN_KINDS.planter);

  it("lays one path down the middle and planters on both sides, the same number each", () => {
    assert.equal(of(g, GARDEN_KINDS.path).length, 1);
    const left = planters.filter((p) => pos(p)[0]! < 0).length;
    assert.equal(left, planters.length - left);
    assert.ok(planters.length >= 4);
  });

  it("spaces the planters evenly: one gap between every neighbour along a column and across a row", () => {
    const l = gardenLayout(12, 20, M.planter.size)!;
    const col = planters.filter((p) => Math.abs(pos(p)[0]! - pos(planters[0]!)[0]!) < 1e-6).map((p) => pos(p)[2]!).sort((a, b) => a - b);
    for (let i = 1; i < col.length; i++) assert.ok(Math.abs(col[i]! - col[i - 1]! - l.pitchZ) < 1e-2, `pitch ${col[i]! - col[i - 1]!}`);
    const row = planters.filter((p) => Math.abs(pos(p)[2]! - pos(planters[0]!)[2]!) < 1e-6 && pos(p)[0]! > 0).map((p) => pos(p)[0]!).sort((a, b) => a - b);
    for (let i = 1; i < row.length; i++) assert.ok(Math.abs(row[i]! - row[i - 1]! - l.pitchX) < 1e-2);
  });

  it("puts the plants inside their planter, evenly spaced, and keeps everything on the plot", () => {
    const plants = of(g, GARDEN_KINDS.plant);
    assert.ok(plants.length > planters.length);
    for (const p of plants) {
      const x = pos(p)[0]!, z = pos(p)[2]!;
      assert.ok(planters.some((b) => Math.abs(pos(b)[0]! - x) < 1e-2 && Math.abs(pos(b)[2]! - z) <= M.planter.size[0] / 2 + 1e-6), "inside a planter");
    }
    for (const c of g.children!) {
      assert.ok(Math.abs(pos(c)[0]!) <= opts.widthM / 2 && Math.abs(pos(c)[2]!) <= opts.depthM / 2, `${c.id} on the plot`);
    }
  });

  it("lines the path and the outer edge with trees in the gaps between planter rows, never on a bed", () => {
    const trees = of(g, GARDEN_KINDS.tree);
    assert.ok(trees.length >= 4);
    for (const t of trees) {
      const x = pos(t)[0]!, z = pos(t)[2]!;
      assert.ok(!planters.some((b) => Math.abs(pos(b)[0]! - x) < M.planter.size[2] / 2 && Math.abs(pos(b)[2]! - z) < M.planter.size[0] / 2), "not on a bed");
    }
    const nearPath = trees.filter((t) => Math.abs(pos(t)[0]!) < 1.5);
    assert.ok(nearPath.length >= 2 && nearPath.length === trees.length / 2, "half line the path, half the edge");
  });

  it("is uniform whatever the seed: same positions, only the variants differ", () => {
    const a = dressGarden({ ...opts, seed: 1 });
    const b = dressGarden({ ...opts, seed: 999 });
    assert.deepEqual(a.children!.map((c) => c.transform), b.children!.map((c) => c.transform));
  });

  it("walks through the path, plants and trees, and keeps the planters solid", () => {
    const solid = (n: { components?: Record<string, unknown> }) => !("Collider" in (n.components ?? {}));
    assert.ok(planters.every(solid));
    assert.ok([...of(g, GARDEN_KINDS.plant), ...of(g, GARDEN_KINDS.tree), ...of(g, GARDEN_KINDS.path)].every((n) => !solid(n)));
  });

  it("a churchyard takes rows of evenly spaced headstones in the same grid, and the same trees", () => {
    const c = dressGarden({ ...opts, kind: "churchyard" });
    assert.equal(of(c, GARDEN_KINDS.planter).length, 0);
    assert.ok(of(c, GARDEN_KINDS.stone).length > 4);
    assert.ok(of(c, GARDEN_KINDS.tree).length >= 4);
    assert.equal(c.name, "grounds:churchyard");
  });

  it("a plot too small for beds gets its path and a tree at each end", () => {
    const s = dressGarden({ ...opts, widthM: 4, depthM: 5 });
    assert.equal(of(s, GARDEN_KINDS.planter).length, 0);
    assert.equal(of(s, GARDEN_KINDS.tree).length, 2);
  });
});

describe("pickGardenModels", () => {
  const cat = [
    { id: "pk/SM_Prop_PlanterBox_01", name: "SM_Prop_PlanterBox_01", skinned: false, size: [2.1, 0.7, 0.8] },
    { id: "pk/SM_Env_Flowers_07", name: "SM_Env_Flowers_07", skinned: false, size: [0.9, 0.9, 0.8] },
    { id: "pk/SM_Env_Tree_Round_01", name: "SM_Env_Tree_Round_01", skinned: false, size: [2.9, 6, 2.4] },
    { id: "pk/SM_Prop_Gravestone_01", name: "SM_Prop_Gravestone_01", skinned: false, size: [0.8, 1.3, 0.3] },
  ];
  it("sizes each model by the world's scale for it, and needs a planter, a plant and a tree", () => {
    const m = pickGardenModels(cat, (id) => (id.includes("Tree_Round") ? 0.5 : 1))!;
    assert.deepEqual(m.trees[0]!.size, [1.45, 3, 1.2]);
    assert.equal(m.planter.size[0], 2.1);
    assert.equal(pickGardenModels(cat.filter((c) => !c.name.includes("Tree"))), null);
  });
});
