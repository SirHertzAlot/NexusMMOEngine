/**
 * Formations: WFC decides what (which kind each site becomes, how many of
 * each piece), scatter and the raymarcher decide where (the pattern round
 * the site, on the ground, not too steep, clear of other pieces). The
 * rules hold across tile borders; a chunk comes out the same whatever
 * order chunks are planned in (with or without the cache); later layers
 * avoid a formation, its unseen centres included.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEcologyPlan, planChunk, type EcologyContext, type EcologyPlan } from "../../src/procgen/ecology.js";
import { FormationCache, formationPieces, formationTile, type FormationEnv, type FormationPoint, type FormationSpec } from "../../src/procgen/formation.js";

const SIDE = 16;
const W = 16;
/** Gentle hills, with a steep bank along z = 200..212. */
const ground = (x: number, z: number): number =>
  5 + Math.sin(x / 23) * 0.6 + Math.cos(z / 31) * 0.5 + (z > 200 && z < 212 ? (z - 200) * 1.5 : z >= 212 ? 18 : 0);

function heights(cx: number, cz: number): Float32Array {
  const h = new Float32Array(SIDE * SIDE);
  for (let j = 0; j < SIDE; j++) for (let i = 0; i < SIDE; i++) h[j * SIDE + i] = ground(cx * W + (i * W) / (SIDE - 1), cz * W + (j * W) / (SIDE - 1));
  return h;
}

const rock = [{ asset: "rock", weight: 1 }];
const pebble = [{ asset: "pebble", weight: 1 }];
const spec: FormationSpec = {
  kinds: [
    {
      id: "circle",
      weight: 1,
      tags: ["circle"],
      pieces: [
        { id: "stone", assets: rock, count: [5, 7], pattern: "ring", radius: [4, 5], clearance: 1.2, maxSlope: 0.35 },
        { id: "altar", assets: pebble, count: [1, 1], pattern: "centre", radius: [0, 0], clearance: 0.8, maxSlope: 0.35 },
      ],
    },
    {
      id: "cairn",
      weight: 1,
      tags: ["cairn"],
      maxPieces: 5,
      pieces: [{ id: "cairn-stone", assets: pebble, count: [3, 6], pattern: "cluster", radius: [0, 1.5], clearance: 0.5, maxSlope: 0.5 }],
    },
  ],
  emptyWeight: 3,
  avoid: [{ a: "circle", b: "circle", distance: 30 }],
  counts: [{ tag: "circle", max: 2 }],
};
const layer = { id: "rings", place: { kind: "formation", spacing: 7, tileChunks: 4 }, chance: 1, formation: spec, assets: [], scale: [1, 1] };
const makePlan = (extra: unknown[] = []): EcologyPlan => parseEcologyPlan({ version: 1, name: "test", fields: {}, biomes: {}, layers: [layer, ...extra] });

const ctx = (cx: number, cz: number, formations?: FormationCache): EcologyContext => ({
  worldSeed: 99n, cx, cz, heights: heights(cx, cz), chunkWorldSize: W, heightsOf: heights, formations,
});
const env: FormationEnv = { seed32: 7, chunkWorldSize: W, heightsOf: heights };

function solveArea(plan: EcologyPlan, t0: number, t1: number): FormationPoint[] {
  const cache = new FormationCache();
  const all: FormationPoint[] = [];
  for (let tj = t0; tj <= t1; tj++) for (let ti = t0; ti <= t1; ti++) all.push(...formationTile(plan, plan.layers[0], env, cache, ti, tj));
  return all;
}

describe("formations: what (WFC)", () => {
  it("makes sites into kinds, apart across tile borders, within their counts", () => {
    const plan = makePlan();
    const all = solveArea(plan, -1, 2);
    const circles = all.filter((p) => p.option === -1);
    const cairns = all.filter((p) => p.option === -2);
    assert.ok(circles.length >= 3 && cairns.length >= 3, `sites: ${circles.length} circles, ${cairns.length} cairns`);
    const sites = [...circles, ...cairns];
    const d = (a: FormationPoint, b: FormationPoint): number => Math.hypot(a.x - b.x, a.z - b.z);
    for (const a of circles) for (const b of circles) if (a !== b) assert.ok(d(a, b) > 30, "circles apart, across tiles too");
    // Any two formations: never overlapping (twice the widest reach apart).
    for (const a of sites) for (const b of sites) if (a !== b) assert.ok(d(a, b) > 12.4, `formations apart (${d(a, b).toFixed(1)})`);
  });

  it("gives each formation its pieces within their counts and the kind's budget", () => {
    const plan = makePlan();
    const all = solveArea(plan, 0, 1);
    const pieces = formationPieces(spec);
    for (const site of all.filter((p) => p.option < 0)) {
      const own = all.filter((p) => p.option >= 0 && p.i === site.i && Math.floor(p.j / 64) === Math.floor(site.j / 64));
      const kind = -1 - site.option;
      assert.ok(own.every((p) => pieces[p.option].kind === kind), "pieces of its own kind");
      if (kind === 1) assert.ok(own.length <= 5, "a cairn within its budget");
      for (const [n, piece] of spec.kinds[kind].pieces.entries()) {
        const have = own.filter((p) => pieces[p.option].piece === spec.kinds[kind].pieces[n]).length;
        assert.ok(have <= piece.count[1], `${piece.id}: ${have} of at most ${piece.count[1]}`);
      }
    }
  });
});

describe("formations: where (scatter + raymarcher)", () => {
  it("sets pieces on the ground by their pattern, clear of each other, never on steep ground", () => {
    const plan = makePlan();
    const all = solveArea(plan, -1, 3);
    const pieces = formationPieces(spec);
    const placed = all.filter((p) => p.option >= 0);
    assert.ok(placed.length > 40, `pieces: ${placed.length}`);
    for (const p of placed) {
      const piece = pieces[p.option].piece;
      assert.ok(Math.abs(p.y - ground(p.x, p.z)) < 0.25, `${piece.id} on the ground (${p.y.toFixed(2)} vs ${ground(p.x, p.z).toFixed(2)})`);
      assert.ok(!(p.z > 200.5 && p.z < 211.5), `${piece.id} not on the steep bank (z ${p.z.toFixed(1)})`);
      const site = all.find((s) => s.option < 0 && s.i === p.i && Math.floor(s.j / 64) === Math.floor(p.j / 64))!;
      const r = Math.hypot(p.x - site.x, p.z - site.z);
      assert.ok(r >= piece.radius[0] - 1e-6 && r <= piece.radius[1] + 1e-6, `${piece.id} at ${r.toFixed(2)} m, within [${piece.radius}]`);
    }
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j];
        const need = Math.max(pieces[a.option].piece.clearance, pieces[b.option].piece.clearance);
        assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= need - 1e-6, "pieces clear of each other, across tiles too");
      }
    // A ring goes all the way round its site.
    const ringSite = all.find((s) => s.option === -1)!;
    const ring = placed.filter((p) => pieces[p.option].piece.pattern === "ring" && p.i === ringSite.i && Math.floor(p.j / 64) === Math.floor(ringSite.j / 64));
    const angles = ring.map((p) => Math.atan2(p.z - ringSite.z, p.x - ringSite.x)).sort((a, b) => a - b);
    const gaps = angles.map((a, k) => (k === 0 ? a + Math.PI * 2 - angles[angles.length - 1] : a - angles[k - 1]));
    assert.ok(Math.max(...gaps) < Math.PI, `no half of the ring empty (largest gap ${Math.max(...gaps).toFixed(2)} rad)`);
  });

  it("gives every chunk the same points whatever order chunks are planned in, cached or not", () => {
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
    assert.ok(spawned.length > 0 && spawned.every((p) => p.assetId === "rock" || p.assetId === "pebble"), "only pieces are spawned (site centres are unseen)");
  });

  it("is avoided by later layers, site centres included", () => {
    const trees = { id: "trees", place: { kind: "field", spacing: 2 }, chance: 1, avoid: { rings: 3 }, assets: [{ asset: "tree", weight: 1 }], scale: [1, 1] };
    const plan = makePlan([trees]);
    const cache = new FormationCache();
    const pts = [0, 1, 2, 3].flatMap((cx) => [0, 1, 2, 3].flatMap((cz) => planChunk(plan, ctx(cx, cz, cache))));
    const rocks = pts.filter((p) => p.layer === "rings");
    const treesPlaced = pts.filter((p) => p.assetId === "tree");
    assert.ok(rocks.length > 0 && treesPlaced.length > 0);
    for (const t of treesPlaced) for (const s of rocks) assert.ok(Math.hypot(t.x - s.x, t.z - s.z) >= 3 - 1e-9, "no tree on a formation's stones");
  });
});

describe("formation plans", () => {
  it("refuse bad ones", () => {
    const layers = (over: Record<string, unknown>) => ({ version: 1, name: "t", fields: {}, biomes: {}, layers: [{ ...layer, ...over }] });
    const f = (over: Partial<FormationSpec>) => layers({ formation: { ...spec, ...over } });
    assert.throws(() => parseEcologyPlan(layers({ formation: undefined })), /formation without a "formation" spec/);
    assert.throws(() => parseEcologyPlan(layers({ avoid: { rings: 1 } })), /doesn't avoid other layers/);
    assert.throws(() => parseEcologyPlan(f({ kinds: [] })), /at least one kind/);
    assert.throws(() => parseEcologyPlan(f({ counts: [{ tag: "tent", max: 1 }] })), /no kind is tagged "tent"/);
    assert.throws(
      () => parseEcologyPlan(f({ kinds: [{ id: "x", weight: 1, pieces: [{ id: "p", assets: rock, count: [3, 1], pattern: "ring", radius: [1, 2], clearance: 1 }] }] })),
      /count must be \[min, max\]/,
    );
    const far = makePlan();
    (far.layers[0].place as { tileChunks: number }).tileChunks = 1;
    assert.throws(() => planChunk(far, ctx(0, 0)), /reaches .* m across tiles, which must be less than its tile/);
  });
});
