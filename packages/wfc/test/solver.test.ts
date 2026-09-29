/**
 * The solver on each kind of constraint, and on the shapes of graph the
 * engine feeds it: a grid of tiles, scatter points, a component tree with
 * a rank budget, a progression from 0% to 100%.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gridProblem, pairsWithin, pointsProblem, solve, WfcError, type GridTile, type WfcOption, type WfcProblem } from "../src/index.js";

const digest = (a: Int32Array): string => createHash("sha256").update(new Uint8Array(a.buffer)).digest("hex").slice(0, 16);

/** A ring of n slots where neighbours must differ. */
function ring(n: number, colours: string[]): WfcProblem {
  return {
    options: colours.map((id) => ({ id })),
    slots: n,
    edges: Array.from({ length: n }, (_, i) => ({ a: i, b: (i + 1) % n, rule: "differ" })),
    rules: { differ: (_x, _y, xi, yi) => xi !== yi },
  };
}

describe("solve", () => {
  it("satisfies edge rules, and is deterministic per seed", () => {
    const p = ring(61, ["red", "green", "blue"]);
    const a = solve(p, { seed: 1 });
    for (let i = 0; i < 61; i++) assert.notEqual(a.assignment[i], a.assignment[(i + 1) % 61]);
    assert.deepEqual(solve(p, { seed: 1 }).assignment, a.assignment);
    assert.notDeepEqual(solve(p, { seed: 2 }).assignment, a.assignment);
  });

  it("backtracks out of dead ends (an odd ring with two colours has none; with three it needs care)", () => {
    assert.throws(() => solve(ring(9, ["a", "b"]), { seed: 1, maxRestarts: 1 }), WfcError);
    const r = solve(ring(9, ["a", "b", "c"]), { seed: 3 });
    for (let i = 0; i < 9; i++) assert.notEqual(r.assignment[i], r.assignment[(i + 1) % 9]);
  });

  it("follows weights", () => {
    const p: WfcProblem = { options: [{ id: "common", weight: 9 }, { id: "rare", weight: 1 }], slots: 4000 };
    const rare = solve(p, { seed: 5 }).ids.filter((id) => id === "rare").length;
    assert.ok(rare > 300 && rare < 500, `about 10% rare: ${rare}`);
  });

  it("keeps pins and domains, and says when a pin can't hold", () => {
    const p = ring(10, ["a", "b", "c"]);
    const r = solve({ ...p, pins: { 0: 2, 5: 2 }, domains: [null, [0, 1]] }, { seed: 9 });
    assert.equal(r.ids[0], "c");
    assert.equal(r.ids[5], "c");
    assert.ok(r.ids[1] === "a" || r.ids[1] === "b");
    assert.throws(() => solve({ ...p, pins: { 0: 0, 1: 0 } }, { seed: 1 }), /no solution: the constraints contradict/);
    assert.throws(() => solve({ ...p, domains: [[0]], pins: { 0: 1 } }, { seed: 1 }), /pinned option b isn't allowed/);
  });

  it("hits exact counts: 10% legendary across a pool", () => {
    const options: WfcOption[] = [{ id: "common", weight: 50 }, { id: "rare", weight: 10 }, { id: "legendary", weight: 1 }];
    const r = solve({ options, slots: 500, counts: [{ options: [2], min: 50, max: 50 }, { options: [1], max: 100 }] }, { seed: 21 });
    assert.equal(r.ids.filter((id) => id === "legendary").length, 50);
    assert.ok(r.ids.filter((id) => id === "rare").length <= 100);
  });

  it("stays within a budget and reaches its minimum (a rank's power budget)", () => {
    // A creature: 6 component slots, each an option costing 0-3; legendary rank = 9 to 11 points.
    const options: WfcOption[] = [0, 1, 2, 3].map((c) => ({ id: `cost${c}` }));
    const cost = [0, 1, 2, 3];
    for (let seed = 1; seed <= 20; seed++) {
      const r = solve({ options, slots: 6, budgets: [{ cost, min: 9, max: 11 }] }, { seed });
      const total = Array.from(r.assignment).reduce((s, x) => s + cost[x], 0);
      assert.ok(total >= 9 && total <= 11, `seed ${seed}: ${total}`);
    }
  });

  it("meets needs: an option only where its neighbours can support it", () => {
    // A path: "tower" needs 2 "wall" neighbours; the ends can never be towers.
    const options: WfcOption[] = [{ id: "wall" }, { id: "tower", weight: 5 }, { id: "gate" }];
    const n = 12;
    const r = solve(
      {
        options,
        slots: n,
        edges: Array.from({ length: n - 1 }, (_, i) => ({ a: i, b: i + 1 })),
        needs: [{ option: 1, from: [0], count: 2 }],
      },
      { seed: 4 },
    );
    assert.notEqual(r.ids[0], "tower");
    assert.notEqual(r.ids[n - 1], "tower");
    for (let i = 1; i < n - 1; i++) if (r.ids[i] === "tower") assert.ok(r.ids[i - 1] === "wall" && r.ids[i + 1] === "wall");
  });

  it("builds a progression from 0% to 100% (a quest)", () => {
    const steps = ["hook", "travel", "ambush", "puzzle", "ally", "twist", "boss", "reward"];
    const options = steps.map((id) => ({ id }));
    const i = (id: string): number => steps.indexOf(id);
    const follows: Record<string, string[]> = {
      hook: ["travel"],
      travel: ["ambush", "puzzle", "ally"],
      ambush: ["travel", "ally", "twist"],
      puzzle: ["travel", "twist", "ambush"],
      ally: ["travel", "ambush", "puzzle"],
      twist: ["boss"],
      boss: ["reward"],
      reward: [],
    };
    const n = 8;
    const r = solve(
      {
        options,
        slots: n,
        edges: Array.from({ length: n - 1 }, (_, k) => ({ a: k, b: k + 1, rule: "next" })),
        rules: { next: (x, y) => follows[x.id].includes(y.id) },
        pins: { 0: i("hook"), [n - 1]: i("reward") },
        // A twist needs an ally somewhere before it: here, a neighbour ally or ambush.
        counts: [{ options: [i("twist")], min: 1, max: 1 }],
      },
      { seed: 12 },
    );
    assert.equal(r.ids[0], "hook");
    assert.equal(r.ids[n - 1], "reward");
    for (let k = 0; k < n - 1; k++) assert.ok(follows[r.ids[k]].includes(r.ids[k + 1]), `${r.ids[k]} -> ${r.ids[k + 1]}`);
  });
});

describe("gridProblem", () => {
  // Land, coast and sea: sea never touches land directly.
  const tiles: GridTile[] = [
    { id: "land", weight: 3, tags: ["land"] },
    { id: "coast", weight: 1 },
    { id: "sea", weight: 3, tags: ["sea"] },
  ];
  const allow = (a: GridTile, b: GridTile): boolean => !((a.id === "land" && b.id === "sea") || (a.id === "sea" && b.id === "land"));

  it("lays out tiles by their rules, and the same seed gives the same map (golden)", () => {
    const g = gridProblem({ width: 40, height: 30, tiles, allow });
    const r = solve(g, { seed: 42 });
    for (let y = 0; y < 30; y++)
      for (let x = 0; x < 40; x++) {
        const t = r.ids[g.index(x, y)];
        if (x + 1 < 40) assert.ok(allow(tiles[r.assignment[g.index(x, y)]], tiles[r.assignment[g.index(x + 1, y)]]), `(${x},${y}) ${t}`);
        if (y + 1 < 30) assert.ok(allow(tiles[r.assignment[g.index(x, y)]], tiles[r.assignment[g.index(x, y + 1)]]));
      }
    assert.equal(digest(r.assignment), "148b4f3b681284d4", "golden: a change to the solver's choices changes every bake");
  });

  it("solves a 128 x 128 map in well under a few seconds", () => {
    const g = gridProblem({ width: 128, height: 128, tiles, allow });
    const t0 = performance.now();
    const r = solve(g, { seed: 1 });
    const ms = performance.now() - t0;
    assert.equal(r.assignment.length, 128 * 128);
    assert.ok(ms < 5000, `${ms.toFixed(0)} ms`);
  });

  it("matches sockets face to face, in 3D", () => {
    // Pipes: a tile's +x socket must meet its neighbour's -x socket.
    const pipes: GridTile[] = [
      { id: "empty", sockets: { px: "0", nx: "0", py: "0", ny: "0", pz: "0", nz: "0" } },
      { id: "straight-x", sockets: { px: "1", nx: "1", py: "0", ny: "0", pz: "0", nz: "0" } },
      { id: "straight-y", sockets: { px: "0", nx: "0", py: "1", ny: "1", pz: "0", nz: "0" } },
      { id: "corner", sockets: { px: "1", nx: "0", py: "1", ny: "0", pz: "0", nz: "0" } },
      { id: "riser", sockets: { px: "0", nx: "0", py: "0", ny: "0", pz: "1", nz: "1" } },
    ];
    const g = gridProblem({ width: 6, height: 6, depth: 3, tiles: pipes });
    const r = solve(g, { seed: 7 });
    for (let z = 0; z < 3; z++)
      for (let y = 0; y < 6; y++)
        for (let x = 0; x < 6; x++) {
          const t = pipes[r.assignment[g.index(x, y, z)]];
          if (x + 1 < 6) assert.equal(t.sockets?.px, pipes[r.assignment[g.index(x + 1, y, z)]].sockets?.nx);
          if (y + 1 < 6) assert.equal(t.sockets?.py, pipes[r.assignment[g.index(x, y + 1, z)]].sockets?.ny);
          if (z + 1 < 3) assert.equal(t.sockets?.pz, pipes[r.assignment[g.index(x, y, z + 1)]].sockets?.nz);
        }
  });
});

describe("pointsProblem", () => {
  // Scatter candidates on a jittered 60 x 60 m field, every 3 m.
  const points: { x: number; y: number }[] = [];
  let h = 7;
  const rnd = (): number => ((h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296;
  for (let y = 0; y < 60; y += 3) for (let x = 0; x < 60; x += 3) points.push({ x: x + rnd() * 2, y: y + rnd() * 2 });
  const options: WfcOption[] = [
    { id: "empty", weight: 6, tags: ["empty"] },
    { id: "fire", weight: 1, tags: ["fire"] },
    { id: "tent", weight: 2, tags: ["tent"] },
    { id: "shrine", weight: 1, tags: ["shrine"] },
  ];
  const dist = (a: number, b: number): number => Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y);

  it("finds the pairs within reach", () => {
    const pairs = pairsWithin(points, 5);
    const brute: [number, number][] = [];
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) if (dist(i, j) <= 5) brute.push([i, j]);
    assert.deepEqual(pairs, brute);
  });

  it("makes camps: tents near a fire, fires apart, one shrine, nothing where it's unsuitable", () => {
    const p = pointsProblem({
      points,
      options,
      avoid: [{ a: "fire", b: "fire", distance: 15 }, { a: "shrine", b: "fire", distance: 10 }],
      needs: [{ tag: "tent", near: "fire", distance: 7 }],
      counts: [{ tag: "shrine", min: 1, max: 1 }],
      // Nothing but empty ground in the west third (a marsh, say).
      weight: (pt, o) => (points[pt].x < 20 && o !== 0 ? 0 : 1),
    });
    for (let seed = 1; seed <= 20; seed++) {
      const r = solve(p, { seed });
      const of = (id: string): number[] => r.ids.flatMap((v, i) => (v === id ? [i] : []));
      const fires = of("fire"), tents = of("tent");
      assert.ok(fires.length > 0 && tents.length > 0);
      for (const a of fires) for (const b of fires) if (a < b) assert.ok(dist(a, b) > 15, `seed ${seed}: fires apart`);
      for (const t of tents) assert.ok(fires.some((f) => dist(t, f) <= 7), `seed ${seed}: every tent near a fire`);
      assert.equal(of("shrine").length, 1);
      for (const f of fires) assert.ok(dist(of("shrine")[0], f) > 10);
      for (let i = 0; i < points.length; i++) if (points[i].x < 20) assert.equal(r.ids[i], "empty");
    }
  });
});
