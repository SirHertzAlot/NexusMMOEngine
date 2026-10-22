/**
 * Arrangement patterns (arrange.ts): rows, grids, flanks and rings laid on a room's distance field. The rooms here are
 * hand-made open rectangles (a solid one-cell border), so each test says exactly what the geometry should be.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GridSdf, placeInRegion, type Placed } from "@mmo-engine/placement";
import { layFlank, layGrid, layRing, layRow, type ArrangeCtx } from "../src/index.js";

/** An open room `w` × `h` cells with a solid border: floor spans (1, w - 1) × (1, h - 1); a wall item at distance r stands at 1 + r. */
function room(w: number, h: number, taken: Placed[] = [], inside?: (x: number, y: number) => boolean): ArrangeCtx {
  const sdf = new GridSdf(w, h, (x, y) => x === 0 || y === 0 || x === w - 1 || y === h - 1);
  return { sdf, inside: inside ?? ((x, y) => x > 1 && x < w - 1 && y > 1 && y < h - 1), taken, centre: { x: w / 2, y: h / 2 } };
}
const northWall = (x: number, r: number): Placed => ({ x, y: 1 + r, rot: Math.PI / 2, nx: 0, ny: 1, radius: r });
const apart = (ps: Placed[]): boolean => ps.every((p, i) => ps.every((q, j) => i === j || Math.hypot(p.x - q.x, p.y - q.y) >= p.radius + q.radius - 1e-9));

describe("layRow", () => {
  it("lays items evenly along the wall, all facing out of it", () => {
    const got = layRow(room(24, 16), northWall(12, 0.6), 0.6, 5, 0.3);
    assert.equal(got.length, 5);
    const xs = got.map((p) => p.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i] - xs[i - 1] - 1.5) < 1e-9, "spaced 2r + gap");
    for (const p of got) {
      assert.ok(Math.abs(p.y - 1.6) < 1e-9, "on one line");
      assert.ok(Math.abs(p.rot - Math.PI / 2) < 1e-9);
    }
  });

  it("is as long as the wall is straight: a round room gives a short row, still against the wall", () => {
    const sdf = new GridSdf(40, 40, (x, y) => Math.hypot(x - 20, y - 20) > 15);
    const inside = (x: number, y: number): boolean => Math.hypot(x - 20, y - 20) < 15;
    const ctx: ArrangeCtx = { sdf, inside, taken: [], centre: { x: 20, y: 20 } };
    const [seed] = placeInRegion(sdf, { x0: 0, y0: 0, x1: 40, y1: 40, inside }, [{ where: "wall", radius: 0.6 }], { seed: 3, taken: [] });
    const got = layRow(ctx, seed!, 0.6, 20, 0.3);
    assert.ok(got.length >= 1 && got.length < 20, `${got.length} fit`);
    for (const p of got) assert.ok(Math.abs(sdf.distance(p.x, p.y) - 0.6) < 0.16, "against the wall");
  });

  it("returns fewer when the wall runs out, and none overlap", () => {
    const got = layRow(room(8, 8), northWall(4, 0.6), 0.6, 9, 0.3);
    assert.ok(got.length >= 2 && got.length < 9, `${got.length} fit`);
    assert.ok(apart(got));
  });

  it("stops at what is in the way and at the room's edge", () => {
    const blocked = layRow(room(24, 16, [{ x: 13.5, y: 1.6, rot: 0, radius: 0.6 }]), northWall(12, 0.6), 0.6, 5, 0.3);
    assert.ok(blocked.every((p) => p.x <= 12 + 1e-9), "nothing past the blocker");
    const cut = layRow(room(24, 16, [], (x, y) => x < 13 && y > 1), northWall(12, 0.6), 0.6, 5, 0.3);
    assert.ok(cut.every((p) => p.x < 13));
  });

  it("asks for nothing, gets nothing", () => assert.deepEqual(layRow(room(24, 16), northWall(12, 0.6), 0.6, 0, 0.3), []));
});

describe("layGrid", () => {
  it("fills a lattice round the room's centre, one facing for all", () => {
    const got = layGrid(room(24, 16), 0.5, 6, 0.3, null);
    assert.equal(got.length, 6);
    for (const p of got) {
      assert.ok(Math.abs((p.x - 12) / 1.3 - Math.round((p.x - 12) / 1.3)) < 1e-9, "x on the lattice");
      assert.ok(Math.abs((p.y - 8) / 1.3 - Math.round((p.y - 8) / 1.3)) < 1e-9, "y on the lattice");
      assert.equal(p.rot, Math.PI / 2);
    }
    assert.ok(apart(got));
  });

  it("faces the point it is given", () => {
    for (const p of layGrid(room(24, 16), 0.5, 4, 0.3, { x: 12, y: 1 })) assert.ok(Math.abs(p.rot + Math.PI / 2) < 1e-9);
  });

  it("keeps to the room", () => {
    const got = layGrid(room(24, 16, [], (x, y) => x > 1 && x < 8 && y > 1 && y < 15), 0.5, 200, 0.3, null);
    assert.ok(got.length > 0 && got.length < 200);
    assert.ok(got.every((p) => p.x < 8));
  });
});

describe("layFlank", () => {
  const anchor: Placed = { x: 12, y: 8, rot: 0, radius: 1 };
  it("stands items either side of the anchor, mirrored, facing as it does", () => {
    const [a, b] = layFlank(room(24, 16), anchor, 0.5, 2, 0.3, 2);
    assert.ok(Math.abs(a.y - 8 - 1.8) < 1e-9 && Math.abs(b.y - 8 + 1.8) < 1e-9, "one each side, 1 + 0.5 + 0.3 from the centre");
    assert.equal(a.x, 12);
    assert.equal(a.rot, 0);
  });
  it("beside: all on one side", () => {
    const got = layFlank(room(24, 16), anchor, 0.5, 2, 0.3, 1);
    assert.equal(got.length, 2);
    assert.ok(got.every((p) => p.y > 8));
    assert.ok(apart(got));
  });
});

describe("layRing", () => {
  it("spaces items round the anchor, facing it", () => {
    const anchor: Placed = { x: 12, y: 8, rot: 0, radius: 1 };
    const got = layRing(room(24, 16), anchor, 0.4, 4, 0.2, "in");
    assert.equal(got.length, 4);
    for (const p of got) {
      assert.ok(Math.abs(Math.hypot(p.x - 12, p.y - 8) - 1.6) < 1e-9);
      const dot = (Math.cos(p.rot) * (12 - p.x) + Math.sin(p.rot) * (8 - p.y)) / 1.6;
      assert.ok(Math.abs(dot - 1) < 1e-9, "rot points at the anchor");
    }
    assert.ok(layRing(room(24, 16), anchor, 0.4, 4, 0.2, "out").every((p) => Math.cos(p.rot) * (p.x - 12) + Math.sin(p.rot) * (p.y - 8) > 0));
  });
});
