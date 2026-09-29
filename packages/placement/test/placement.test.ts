/**
 * The distance field, the raymarcher and placement against known shapes:
 * a walled room, a pillar, sloped ground.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GridSdf, HeightfieldSdf, march2, normal2, placeInRegion, poissonDisc, snapToGround, type PlaceItem } from "../src/index.js";

/** A 20 × 12 room: walls on the border, open inside (cells 1..18 × 1..10), a 2 × 2 pillar at (9..10, 5..6). */
const W = 20, H = 12;
const solid = (x: number, y: number): boolean => x === 0 || y === 0 || x === W - 1 || y === H - 1 || (x >= 9 && x <= 10 && y >= 5 && y <= 6);
const room = new GridSdf(W, H, solid);
const open = { x0: 1, y0: 1, x1: W - 1, y1: H - 1, inside: (x: number, y: number) => room.distance(x, y) > 0 };

describe("GridSdf", () => {
  it("measures the distance to the nearest wall surface, negative inside walls", () => {
    // The west wall's surface is at x = 1; the pillar's west face at x = 9.
    assert.ok(Math.abs(room.distance(3.5, 3.5) - 2.5) < 1e-6, `${room.distance(3.5, 3.5)}`);
    assert.ok(Math.abs(room.distance(1.5, 8.5) - 0.5) < 1e-6);
    assert.ok(room.distance(0.5, 5.5) < 0, "inside the wall");
    assert.ok(room.distance(9.5, 5.5) < 0, "inside the pillar");
    assert.ok(Math.abs(room.distance(7.5, 5.5) - 1.5) < 1e-6, "1.5 from the pillar's face");
  });
});

describe("march2", () => {
  it("stops at the first surface along the ray, with its normal", () => {
    const hit = march2(room, 3.5, 5.5, 1, 0, { maxDistance: 50 });
    assert.ok(hit, "hits the pillar");
    assert.ok(Math.abs(hit!.x - 9) < 0.02, `pillar face at x = 9, got ${hit!.x}`);
    assert.ok(hit!.nx < -0.9, "the face looks back along -x");
    const wall = march2(room, 3.5, 3.5, 0, -1, { maxDistance: 50 });
    assert.ok(wall && Math.abs(wall.y - 1) < 0.02 && wall.ny > 0.9, "the north wall, facing south");
    assert.equal(march2(room, 3.5, 3.5, 1, 0, { maxDistance: 2 }), null, "out of reach");
    assert.equal(march2(room, 0.5, 5.5, 1, 0, { maxDistance: 50 }), null, "starting inside a wall is no hit");
  });

  it("points normals away from the nearest surface", () => {
    const [nx] = normal2(room, 2.5, 3.5);
    assert.ok(nx > 0.9, "near the west wall the field grows eastward");
  });
});

describe("poissonDisc", () => {
  it("keeps points apart, inside the region, deterministically", () => {
    const a = poissonDisc(open, 1.2, 7);
    const b = poissonDisc(open, 1.2, 7);
    assert.deepEqual(a, b);
    assert.ok(a.length > 60, `fills the room: ${a.length}`);
    for (const p of a) assert.ok(open.inside(p.x, p.y));
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) assert.ok(Math.hypot(a[i].x - a[j].x, a[i].y - a[j].y) >= 1.2 - 1e-9);
  });
});

describe("placeInRegion", () => {
  const items: PlaceItem[] = [
    { where: "centre", radius: 1.4 },
    { where: "wall", radius: 0.6 },
    { where: "wall", radius: 0.6 },
    { where: "corner", radius: 0.4 },
    { where: "corner", radius: 0.4 },
    { where: "wall", radius: 0.2, mount: true },
    { where: "floor", radius: 0.5 },
    { where: "floor", radius: 0.5 },
  ];

  it("puts each item where it asked, clear of walls and of each other", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const out = placeInRegion(room, open, items, { seed });
      assert.equal(out.length, items.length);
      out.forEach((p, k) => {
        assert.ok(p, `seed ${seed}: item ${k} placed`);
        const it = items[k];
        const d = room.distance(p!.x, p!.y);
        if (it.mount) assert.ok(Math.abs(d) < 0.05, `seed ${seed}: mounted on the wall surface (${d})`);
        else assert.ok(d >= it.radius - 1e-3, `seed ${seed}: item ${k} has clearance (${d} < ${it.radius})`);
        if (it.where === "wall" && !it.mount) assert.ok(d < it.radius + 0.05, `seed ${seed}: against a wall`);
        if (it.where === "wall" || it.where === "corner") {
          // It faces out of its wall: a step along its facing opens up.
          assert.ok(room.distance(p!.x + Math.cos(p!.rot) * 0.3, p!.y + Math.sin(p!.rot) * 0.3) > d, `seed ${seed}: faces out`);
        }
      });
      const standing = out.filter((p, k) => p && !items[k].mount) as NonNullable<(typeof out)[number]>[];
      for (let i = 0; i < standing.length; i++)
        for (let j = i + 1; j < standing.length; j++) {
          const a = standing[i], b = standing[j];
          assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius - 1e-6, `seed ${seed}: items apart`);
        }
      // The centre piece stands in the open: away from every wall by more than most spots.
      assert.ok(room.distance(out[0]!.x, out[0]!.y) > 2, `seed ${seed}: centre in the open`);
      // Corners: two walls within reach.
      for (const k of [3, 4]) {
        const p = out[k]!;
        const walls = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => march2(room, p.x, p.y, dx, dy, { maxDistance: 1.5 }));
        assert.ok(walls.length >= 2, `seed ${seed}: corner item has two walls near (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
      }
    }
  });

  it("returns null for what doesn't fit, and keeps clear of what's already there", () => {
    const [big] = placeInRegion(room, open, [{ where: "centre", radius: 9 }], { seed: 1 });
    assert.equal(big, null);
    const taken = [{ x: 5, y: 5, rot: 0, radius: 3 }];
    const out = placeInRegion(room, open, [{ where: "floor", radius: 0.5 }, { where: "floor", radius: 0.5 }], { seed: 2, taken });
    for (const p of out) assert.ok(p && Math.hypot(p.x - 5, p.y - 5) >= 3.5 - 1e-6);
  });
});

describe("snapToGround", () => {
  it("drops onto sloped ground and reports its normal", () => {
    const height = (x: number, z: number): number => 0.5 * x + 2 + 0 * z;
    const sdf = new HeightfieldSdf(height, 0.5);
    const g = snapToGround(sdf, 4, 3, 50);
    assert.ok(g && Math.abs(g.y - 4) < 0.01, `lands on y = 4, got ${g?.y}`);
    const [nx, ny] = g!.normal;
    assert.ok(nx < 0 && ny > 0.85, "the slope's normal leans back uphill");
  });
});
