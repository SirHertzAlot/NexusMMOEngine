/**
 * Arrangement patterns (arrange.ts): rows, grids, flanks and rings laid on a room's distance field. The rooms here are
 * hand-made open rectangles (a solid one-cell border), so each test says exactly what the geometry should be.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GridSdf, placeInRegion, type Placed } from "@mmo-engine/placement";
import { layBefore, layFlank, layGrid, layLine, layRing, layRow, reachOf, type ArrangeCtx } from "../src/index.js";

/** An open room `w` × `h` cells with a solid border: floor spans (1, w - 1) × (1, h - 1); a wall item at distance r stands at 1 + r. */
function room(w: number, h: number, taken: Placed[] = [], inside?: (x: number, y: number) => boolean): ArrangeCtx {
  const sdf = new GridSdf(w, h, (x, y) => x === 0 || y === 0 || x === w - 1 || y === h - 1);
  return { sdf, inside: inside ?? ((x, y) => x > 1 && x < w - 1 && y > 1 && y < h - 1), taken, centre: { x: w / 2, y: h / 2 }, extent: { w, h } };
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

  it("faces the point it is given, square to the room's axes", () => {
    for (const p of layGrid(room(24, 16), 0.5, 4, 0.3, { x: 12, y: 1 })) assert.ok(Math.abs(p.rot + Math.PI / 2) < 1e-9);
    for (const p of layGrid(room(24, 16), 0.5, 4, 0.3, { x: 3, y: 15 })) assert.ok(Math.abs(Math.round(p.rot / (Math.PI / 2)) * (Math.PI / 2) - p.rot) < 1e-9, "snapped to an axis");
  });

  it("fills one row across the room before starting the next", () => {
    const got = layGrid(room(24, 16), 0.5, 5, 0.3, null);
    assert.equal(new Set(got.map((p) => p.y.toFixed(6))).size, 1, "five items, one row");
    // A narrow room (six cells across) holds three to a row (centres at least a radius off each wall): nine items make three full rows.
    const narrow = layGrid(room(8, 16), 0.5, 9, 0.3, null);
    const rows = new Map<string, number>();
    for (const p of narrow) rows.set(p.y.toFixed(6), (rows.get(p.y.toFixed(6)) ?? 0) + 1);
    assert.equal(narrow.length, 9);
    assert.equal(rows.size, 3);
    assert.deepEqual([...rows.values()], [3, 3, 3]);
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

describe("reach: slim, long items", () => {
  it("a row stands its items `reach` from the wall and `2 * radius + gap` apart", () => {
    const got = layRow(room(24, 16), { x: 12, y: 1.9, rot: Math.PI / 2, nx: 0, ny: 1, radius: 0.9 }, 0.3, 5, 0.1, { reach: 0.9 });
    assert.equal(got.length, 5);
    for (const p of got) assert.ok(Math.abs(p.y - 1.9) < 1e-9, "heads 0.9 from the wall");
    const xs = got.map((p) => p.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i] - xs[i - 1] - 0.7) < 1e-9, "0.6 + 0.1 apart");
    assert.ok(got.every((p) => reachOf(p) === 0.9));
  });

  it("a grid facing along y has the long pitch down the room and the short one across it", () => {
    const got = layGrid(room(24, 16), 0.3, 6, 0.1, null, { reach: 0.9 });
    const ys = [...new Set(got.map((p) => p.y.toFixed(6)))];
    assert.equal(ys.length, 1, "six slim items fit across one row");
    const next = layGrid(room(24, 16), 0.3, 40, 0.1, null, { reach: 0.9 });
    const rows = [...new Set(next.map((p) => p.y))].sort((a, b) => a - b);
    assert.ok(Math.abs(rows[1] - rows[0] - 1.9) < 1e-9, "rows 2 * reach + gap apart");
  });
});

describe("layLine", () => {
  it("runs down the long axis through the centre, evenly spaced, facing along it", () => {
    const got = layLine(room(24, 16), 0.5, 5, 0.5, 0);
    assert.equal(got.length, 5);
    assert.ok(got.every((p) => Math.abs(p.y - 8) < 1e-9 && p.rot === 0), "along +x on y = 8");
    const xs = got.map((p) => p.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i] - xs[i - 1] - 1.5) < 1e-9);
    const tall = layLine(room(16, 24), 0.5, 5, 0.5, 0);
    assert.ok(tall.every((p) => Math.abs(p.x - 8) < 1e-9 && Math.abs(p.rot - Math.PI / 2) < 1e-9), "along y in a tall room");
  });

  it("can run off the centreline, and skips what does not fit", () => {
    assert.ok(layLine(room(24, 16), 0.5, 4, 0.5, 2).every((p) => Math.abs(p.y - 10) < 1e-9));
    const blocked = layLine(room(24, 16, [{ x: 12, y: 8, rot: 0, radius: 0.5 }]), 0.5, 5, 0.5, 0);
    assert.equal(blocked.length, 5, "the blocked middle is skipped, the line goes on");
    assert.ok(blocked.every((p) => Math.hypot(p.x - 12, p.y - 8) >= 1 - 1e-6));
  });
});

describe("layBefore", () => {
  const beds = [0, 1, 2].map((i) => ({ x: 8 + i * 2, y: 1.9, rot: Math.PI / 2, nx: 0, ny: 1, radius: 0.5, reach: 0.9 }));
  it("puts one item in front of each anchor, facing as it does", () => {
    const got = layBefore(room(24, 16), beds, 0.3, 0.1, { reach: 0.3 });
    assert.equal(got.length, 3);
    got.forEach((p, i) => {
      assert.ok(Math.abs(p.x - beds[i].x) < 1e-9 && Math.abs(p.y - (1.9 + 0.9 + 0.3 + 0.1)) < 1e-9);
      assert.equal(p.rot, Math.PI / 2);
    });
  });
  it("skips an anchor with no room in front", () => {
    const got = layBefore(room(24, 16, [{ x: 10, y: 3.2, rot: 0, radius: 0.5 }]), beds, 0.3, 0.1, { reach: 0.3 });
    assert.equal(got.length, 2);
  });
});

describe("mounted rows", () => {
  it("hang on the wall, and a floor item standing in front does not block them", () => {
    const wall = { x: 12, y: 1.01, rot: Math.PI / 2, nx: 0, ny: 1, radius: 0.5 };
    const got = layRow(room(24, 16), wall, 0.5, 5, 0.5, { mounted: true });
    assert.equal(got.length, 5);
    assert.ok(got.every((p) => Math.abs(p.y - 1.01) < 1e-9), "on the wall");
    // The room's floor items are not passed as `taken` for a mounted call (dress.ts passes the mounted ones only).
    assert.equal(layRow(room(24, 16, [{ x: 13.5, y: 1.01, rot: 0, radius: 0.5 }]), wall, 0.5, 5, 0.5, { mounted: true }).every((p) => p.x <= 12 + 1e-9), true, "another mounted item does block");
  });
  it("stop at a doorway gap", () => {
    const wall = { x: 12, y: 1.01, rot: Math.PI / 2, nx: 0, ny: 1, radius: 0.5 };
    const got = layRow(room(24, 16, [], (x, y) => x > 1 && x < 23 && y > 1 && !(x > 14 && x < 17)), wall, 0.5, 9, 0.5, { mounted: true });
    assert.ok(got.every((p) => p.x < 14), "nothing hangs in the doorway or beyond it");
  });
});
