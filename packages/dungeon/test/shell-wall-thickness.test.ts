/**
 * Wall thickness: at 0 the shell is the inside surface, as before. Above 0
 * the shell is a closed wall body: the same inside, plus outside faces
 * tagged outer that stand the thickness past the painted cells on every side.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { BUILTIN_THEMES, dungeonFromLayout, dungeonShell, generateDungeon, parseLayoutMask, parseShellTheme, shellCollision, shellOptionsOf, SHELL_PARTS, type DungeonShell, type GeometryOps } from "../src/index.js";

const require = createRequire(import.meta.url);
const geo = require("@mmo-engine/addon-geometry") as GeometryOps;
const OUTER = SHELL_PARTS.indexOf("outer");
const CEILING = SHELL_PARTS.indexOf("ceiling");

// One flat ceiling everywhere, so the body is a plain box round a plain box.
const H = 4;
const FLAT = { corridorHeight: H, roomHeight: { s: H, m: H, l: H } };
const layout = (rows: string[]) => dungeonFromLayout(parseLayoutMask({ version: 1 as const, rows, entrance: { x: 1, y: 1 }, portals: [] }), "walls");
// A 5 x 3 cell room: 10 m by 6 m of floor, from x 2 to 12 and z 2 to 8.
const RECT = layout(["#######", "#.....#", "#.....#", "#.....#", "#######"]);
// Two 2 x 2 rooms with three cells (6 m) of rock between them.
const APART = layout(["#########", "#..###..#", "#..###..#", "#########"]);
// The same rooms with one cell (2 m) of rock between them.
const CLOSE = layout(["#######", "#..#..#", "#..#..#", "#######"]);

const count = (s: DungeonShell, part: number): number => s.parts.reduce((n, p) => n + (p === part ? 1 : 0), 0);

/** Triangles on each undirected edge, by vertex position (the solid may repeat a vertex where tags meet). */
function edgeUse(s: DungeonShell): number[] {
  const key = (v: number): string => `${s.positions[v * 3].toFixed(4)},${s.positions[v * 3 + 1].toFixed(4)},${s.positions[v * 3 + 2].toFixed(4)}`;
  const use = new Map<string, number>();
  for (let t = 0; t < s.parts.length; t++) {
    for (let j = 0; j < 3; j++) {
      const a = key(s.indices[t * 3 + j]), b = key(s.indices[t * 3 + ((j + 1) % 3)]);
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      use.set(e, (use.get(e) ?? 0) + 1);
    }
  }
  return [...use.values()];
}

/** Does any outer triangle cover the point (x, z), seen from above? */
function outerOver(s: DungeonShell, x: number, z: number): boolean {
  const p = s.positions;
  for (let t = 0; t < s.parts.length; t++) {
    if (s.parts[t] !== OUTER) continue;
    const [a, b, c] = [0, 1, 2].map((j) => s.indices[t * 3 + j] * 3);
    const d = (p[b + 2] - p[c + 2]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 2] - p[c + 2]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((p[b + 2] - p[c + 2]) * (x - p[c]) + (p[c] - p[b]) * (z - p[c + 2])) / d;
    const l2 = ((p[c + 2] - p[a + 2]) * (x - p[c]) + (p[a] - p[c]) * (z - p[c + 2])) / d;
    if (l1 >= 0 && l2 >= 0 && 1 - l1 - l2 >= 0) return true;
  }
  return false;
}

describe("shell wall thickness", () => {
  it("0 is the default and changes nothing: no outer faces, the same mesh", () => {
    const plain = dungeonShell(RECT, geo, FLAT);
    const zero = dungeonShell(RECT, geo, { ...FLAT, wallThickness: 0 });
    assert.equal(count(plain, OUTER), 0);
    assert.deepEqual(zero.positions, plain.positions);
    assert.deepEqual(zero.indices, plain.indices);
    assert.deepEqual(zero.parts, plain.parts);
    assert.equal(plain.stats.wallVolume, 0);
  });

  it("a thickness adds outer faces that stand that far past the painted cells on every side", () => {
    const t = 0.5;
    const s = dungeonShell(RECT, geo, { ...FLAT, wallThickness: t });
    assert.ok(count(s, OUTER) > 0, "outer faces");
    const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-4, `${a} is not ${b}`);
    near(s.bounds.min[0], 2 - t);
    near(s.bounds.max[0], 12 + t);
    near(s.bounds.min[2], 2 - t);
    near(s.bounds.max[2], 8 + t);
    near(s.bounds.min[1], -t);
    near(s.bounds.max[1], H + t);
  });

  it("the inside is the same space, and the body's volume is the grown box less the space", () => {
    const t = 0.5;
    const plain = dungeonShell(RECT, geo, FLAT);
    const s = dungeonShell(RECT, geo, { ...FLAT, wallThickness: t });
    assert.ok(Math.abs(s.stats.volume - plain.stats.volume) < 1e-3, `space ${s.stats.volume} against ${plain.stats.volume}`);
    assert.ok(Math.abs(s.stats.volume - 10 * 6 * H) < 1e-3);
    assert.equal(s.stats.floorArea, plain.stats.floorArea);
    const expected = (10 + 2 * t) * (6 + 2 * t) * (H + 2 * t) - 10 * 6 * H;
    assert.ok(Math.abs(s.stats.wallVolume - expected) < 1e-2, `wall ${s.stats.wallVolume} against ${expected}`);
    for (const part of ["floor", "wall", "ceiling"] as const) {
      const i = SHELL_PARTS.indexOf(part);
      assert.equal(count(s, i), count(plain, i), part);
    }
  });

  it("the shell is a closed mesh: every edge is shared by exactly two triangles", () => {
    const s = dungeonShell(RECT, geo, { ...FLAT, wallThickness: 0.5 });
    const use = edgeUse(s);
    assert.ok(use.every((n) => n === 2), `edge uses ${[...new Set(use)].join(", ")}`);
    // The inside surface alone is closed too, so it was already; the outside adds a second closed skin.
    assert.ok(edgeUse(dungeonShell(RECT, geo, FLAT)).every((n) => n === 2));
  });

  it("rooms far apart get a wall each with a gap between; rooms close together share solid rock", () => {
    const t = 0.5;
    // APART: rooms at x 2..6 and 12..16, so the rock between runs x 6..12. Its middle is outside both walls.
    const apart = dungeonShell(APART, geo, { ...FLAT, wallThickness: t });
    assert.equal(outerOver(apart, 9, 4), false, "nothing stands between the two rooms");
    assert.equal(outerOver(apart, 6.25, 4), true, "the first room's wall");
    assert.equal(outerOver(apart, 11.75, 4), true, "the second room's wall");
    // CLOSE with walls a metre thick: the 2 m of rock between the rooms is all wall.
    const close = dungeonShell(CLOSE, geo, { ...FLAT, wallThickness: 1 });
    assert.equal(outerOver(close, 7, 4), true, "solid between the rooms");
    // The two rooms span x 2..12 and z 2..6, so the body is 12 by 6 by 6 less two rooms of 4 by 4 by 4.
    const expected = (10 + 2) * (4 + 2) * (H + 2) - 2 * (4 * 4 * H);
    assert.ok(Math.abs(close.stats.wallVolume - expected) < 1e-2, `wall ${close.stats.wallVolume} against ${expected}`);
  });

  it("an open ceiling has no roof slab: the walls end level with the space's top", () => {
    const s = dungeonShell(RECT, geo, { ...FLAT, wallThickness: 0.5, ceilingMode: "open" });
    assert.equal(count(s, CEILING), 0);
    assert.ok(Math.abs(s.bounds.max[1] - H) < 1e-4, `top ${s.bounds.max[1]}`);
    assert.ok(count(s, OUTER) > 0);
  });

  it("generated dungeons stay closed with a wall body: flat, pillared and open to the sky", () => {
    const d = generateDungeon({ seed: 1, rooms: 12, loopChance: 0.15, decorDensity: 0.6, theme: "ancient" }, BUILTIN_THEMES.ancient);
    for (const extra of [{}, { cornerMode: "pillared" as const }, { ceilingMode: "open" as const }]) {
      const plain = dungeonShell(d, geo, extra);
      const s = dungeonShell(d, geo, { ...extra, wallThickness: 0.5 });
      const use = edgeUse(s);
      assert.ok(use.every((n) => n === 2), `${JSON.stringify(extra)}: edge uses ${[...new Set(use)].join(", ")}`);
      assert.ok(Math.abs(s.stats.volume - plain.stats.volume) < 0.05, `${JSON.stringify(extra)}: space ${s.stats.volume} against ${plain.stats.volume}`);
    }
  });

  it("the outside is solid for collision", () => {
    const plain = dungeonShell(RECT, geo, FLAT);
    const s = dungeonShell(RECT, geo, { ...FLAT, wallThickness: 0.5 });
    assert.equal(shellCollision(s).triangles, shellCollision(plain).triangles + count(s, OUTER));
  });

  it("refuses a thickness below 0 or above one cell", () => {
    assert.throws(() => dungeonShell(RECT, geo, { ...FLAT, wallThickness: -0.1 }), /wallThickness/);
    assert.throws(() => dungeonShell(RECT, geo, { ...FLAT, wallThickness: 2.5 }), /wallThickness/);
    assert.throws(() => dungeonShell(RECT, geo, { ...FLAT, wallThickness: Number.NaN }), /wallThickness/);
  });

  it("the theme carries wallThickness through to the shell, 0 by default", () => {
    assert.equal(parseShellTheme({}).wallThickness, 0);
    assert.equal(shellOptionsOf(parseShellTheme({ wallThickness: 0.75 })).wallThickness, 0.75);
    assert.throws(() => parseShellTheme({ wallThickness: 3 }));
    assert.throws(() => parseShellTheme({ wallThickness: -1 }));
  });
});
