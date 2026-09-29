/**
 * Formations: ecology points decided together by WFC. The constraints
 * hold everywhere, across tile borders included; a chunk comes out the
 * same whatever order chunks are planned in (and with or without the
 * cache); later layers can avoid a formation's points.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEcologyPlan, planChunk, type EcologyContext, type EcologyPlan } from "../../src/procgen/ecology.js";
import { FormationCache, formationTile, type FormationEnv, type FormationPoint } from "../../src/procgen/formation.js";

const SIDE = 16;
const W = 16;
const ground = (x: number, z: number): number => 5 + Math.sin(x / 23) * 0.6 + Math.cos(z / 31) * 0.5;

function heights(cx: number, cz: number): Float32Array {
  const h = new Float32Array(SIDE * SIDE);
  for (let j = 0; j < SIDE; j++) for (let i = 0; i < SIDE; i++) h[j * SIDE + i] = ground(cx * W + (i * W) / (SIDE - 1), cz * W + (j * W) / (SIDE - 1));
  return h;
}

const rock = [{ asset: "rock", weight: 1 }];
const circles = {
  id: "circles",
  place: { kind: "formation", spacing: 2.5, tileChunks: 4 },
  chance: 1,
  formation: {
    options: [
      { id: "ground", weight: 40 },
      { id: "centre", weight: 0.3, tags: ["centre"] },
      { id: "stone", weight: 3, tags: ["stone"], assets: rock },
    ],
    avoid: [
      { a: "centre", b: "centre", distance: 30 },
      { a: "stone", b: "stone", distance: 2.4 },
      { a: "stone", b: "centre", distance: 3.5 },
    ],
    needs: [
      { tag: "stone", near: "centre", distance: 6.5 },
      { tag: "centre", near: "stone", distance: 6.5, count: 5 },
    ],
    counts: [{ tag: "centre", max: 2 }],
  },
  assets: [],
  scale: [1, 1],
};

const makePlan = (extra: unknown[] = []): EcologyPlan =>
  parseEcologyPlan({ version: 1, name: "test", fields: {}, biomes: {}, layers: [circles, ...extra] });

const ctx = (cx: number, cz: number, formations?: FormationCache): EcologyContext => ({
  worldSeed: 99n,
  cx,
  cz,
  heights: heights(cx, cz),
  chunkWorldSize: W,
  heightsOf: heights,
  formations,
});

const env: FormationEnv = { seed32: 0, chunkWorldSize: W, heightsOf: heights };

describe("formations", () => {
  it("hold every constraint, across tile borders too", () => {
    const plan = makePlan();
    const layer = plan.layers[0];
    const cache = new FormationCache();
    const all: FormationPoint[] = [];
    for (let tj = -1; tj <= 2; tj++) for (let ti = -1; ti <= 2; ti++) all.push(...formationTile(plan, layer, { ...env, seed32: 7 }, cache, ti, tj));
    const centres = all.filter((p) => p.option === 1);
    const stones = all.filter((p) => p.option === 2);
    assert.ok(centres.length >= 4, `circles found: ${centres.length}`);
    const d = (a: FormationPoint, b: FormationPoint): number => Math.hypot(a.x - b.x, a.z - b.z);
    for (const a of centres) for (const b of centres) if (a !== b) assert.ok(d(a, b) > 30, "circles apart, across tiles too");
    for (const a of stones) for (const b of stones) if (a !== b) assert.ok(d(a, b) > 2.4, "stones apart");
    for (const s of stones) {
      assert.ok(centres.some((c) => d(s, c) <= 6.5), "every stone stands by a centre");
      for (const c of centres) assert.ok(d(s, c) > 3.5, "a clear middle");
    }
    for (const c of centres) assert.ok(stones.filter((s) => d(s, c) <= 6.5).length >= 5, "a ring of at least five");
  });

  it("give every chunk the same points whatever order chunks are planned in, cached or not", () => {
    const plan = makePlan();
    const chunks: [number, number][] = [];
    for (let cz = -2; cz < 6; cz++) for (let cx = -2; cx < 6; cx++) chunks.push([cx, cz]);
    const shared = new FormationCache();
    const forward = new Map(chunks.map(([cx, cz]) => [`${cx},${cz}`, planChunk(plan, ctx(cx, cz, shared))]));
    const reverseCache = new FormationCache();
    for (const [cx, cz] of [...chunks].reverse()) {
      assert.deepEqual(planChunk(plan, ctx(cx, cz, reverseCache)), forward.get(`${cx},${cz}`), `chunk ${cx},${cz} (reverse order)`);
      assert.deepEqual(planChunk(plan, ctx(cx, cz)), forward.get(`${cx},${cz}`), `chunk ${cx},${cz} (no cache)`);
    }
    const spawned = [...forward.values()].flat();
    assert.ok(spawned.length > 0 && spawned.every((p) => p.assetId === "rock"), "only stones are spawned (centres are unseen)");
  });

  it("are avoided by later layers, centres included", () => {
    const trees = { id: "trees", place: { kind: "field", spacing: 2 }, chance: 1, avoid: { circles: 7 }, assets: [{ asset: "tree", weight: 1 }], scale: [1, 1] };
    const plan = makePlan([trees]);
    const cache = new FormationCache();
    const pts = [0, 1, 2, 3].flatMap((cx) => [0, 1, 2, 3].flatMap((cz) => planChunk(plan, ctx(cx, cz, cache))));
    const stones = pts.filter((p) => p.assetId === "rock");
    const treesPlaced = pts.filter((p) => p.assetId === "tree");
    assert.ok(stones.length > 0 && treesPlaced.length > 0);
    for (const t of treesPlaced) for (const s of stones) assert.ok(Math.hypot(t.x - s.x, t.z - s.z) >= 7 - 1e-9, "no tree in a circle");
  });

  it("refuse bad plans", () => {
    const layers = (over: Record<string, unknown>) => ({ version: 1, name: "t", fields: {}, biomes: {}, layers: [{ ...circles, ...over }] });
    assert.throws(() => parseEcologyPlan(layers({ formation: undefined })), /formation without a "formation" spec/);
    assert.throws(() => parseEcologyPlan(layers({ avoid: { circles: 1 } })), /doesn't avoid other layers/);
    assert.throws(
      () => parseEcologyPlan(layers({ formation: { ...circles.formation, counts: [{ tag: "tent", max: 1 }] } })),
      /no option is tagged "tent"/,
    );
    const far = makePlan();
    (far.layers[0].place as { tileChunks: number }).tileChunks = 1;
    assert.throws(() => planChunk(far, ctx(0, 0)), /reaches 30 m, which must be less than its tile/);
  });
});
