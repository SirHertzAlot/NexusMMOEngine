/**
 * Corner modes: square leaves the shell as it was; chamfered cuts each room
 * corner at 45 degrees; pillared stands a square column on every corner of
 * the floor plan. Checked by the space each mode takes out of the room.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dungeonFromLayout, dungeonShell, parseLayoutMask, parseShellTheme, shellOptionsOf, SHELL_PARTS, type GeometryOps } from "../src/index.js";

const require = createRequire(import.meta.url);
const geo = require("@mmo-engine/addon-geometry") as GeometryOps;
const WALL = SHELL_PARTS.indexOf("wall");

// One flat ceiling everywhere, so a corner's height is the same in every test.
const FLAT = { corridorHeight: 4, roomHeight: { s: 4, m: 4, l: 4 } };
const H = 4;
const layout = (rows: string[]) => dungeonFromLayout(parseLayoutMask({ version: 1 as const, rows, entrance: { x: 1, y: 1 }, portals: [] }), "corners");
// A rectangle: four corners where the walls turn in (convex for the room).
const RECT = layout(["#######", "#.....#", "#.....#", "#.....#", "#######"]);
// An L: five convex corners and one where the wall turns out into the room.
const ELL = layout(["#######", "#.....#", "#.....#", "#..####", "#..####", "#######"]);

/** How many wall triangles face neither along x nor along z (a diagonal face). */
function diagonalWalls(s: ReturnType<typeof dungeonShell>): number {
  let n = 0;
  for (let t = 0; t < s.parts.length; t++) {
    if (s.parts[t] !== WALL) continue;
    const [a, b, c] = [0, 1, 2].map((j) => s.indices[t * 3 + j] * 3);
    const ux = s.positions[b] - s.positions[a], uy = s.positions[b + 1] - s.positions[a + 1], uz = s.positions[b + 2] - s.positions[a + 2];
    const vx = s.positions[c] - s.positions[a], vy = s.positions[c + 1] - s.positions[a + 1], vz = s.positions[c + 2] - s.positions[a + 2];
    const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
    if (Math.abs(nx) > 1e-6 && Math.abs(nz) > 1e-6) n++;
  }
  return n;
}

describe("shell corner modes", () => {
  it("square is the default and changes nothing", () => {
    const plain = dungeonShell(RECT, geo, FLAT);
    const square = dungeonShell(RECT, geo, { ...FLAT, cornerMode: "square" });
    assert.equal(square.stats.triangles, plain.stats.triangles);
    assert.equal(square.stats.volume, plain.stats.volume);
    assert.equal(diagonalWalls(plain), 0);
  });

  it("chamfered cuts a triangle of the given leg off each of a rectangle's four corners", () => {
    const plain = dungeonShell(RECT, geo, FLAT);
    const cut = dungeonShell(RECT, geo, { ...FLAT, cornerMode: "chamfered", cornerSize: 0.5 });
    const expected = 4 * ((0.5 * 0.5) / 2) * H;
    assert.ok(Math.abs(plain.stats.volume - cut.stats.volume - expected) < 1e-2, `removed ${plain.stats.volume - cut.stats.volume}, expected ${expected}`);
    assert.ok(diagonalWalls(cut) >= 8, "each chamfer is a diagonal wall face (two triangles)");
  });

  it("a larger chamfer removes more", () => {
    const small = dungeonShell(RECT, geo, { ...FLAT, cornerMode: "chamfered", cornerSize: 0.5 });
    const large = dungeonShell(RECT, geo, { ...FLAT, cornerMode: "chamfered", cornerSize: 1 });
    assert.ok(large.stats.volume < small.stats.volume);
  });

  it("chamfered leaves the corner that turns out into the room alone (five cuts on the L)", () => {
    const plain = dungeonShell(ELL, geo, FLAT);
    const cut = dungeonShell(ELL, geo, { ...FLAT, cornerMode: "chamfered", cornerSize: 0.5 });
    const expected = 5 * ((0.5 * 0.5) / 2) * H;
    assert.ok(Math.abs(plain.stats.volume - cut.stats.volume - expected) < 1e-2, `removed ${plain.stats.volume - cut.stats.volume}, expected ${expected}`);
  });

  it("pillared stands a column on every corner: a quarter shows at a room corner, three quarters where the wall turns out", () => {
    const s = 0.5;
    const rectPlain = dungeonShell(RECT, geo, FLAT);
    const rect = dungeonShell(RECT, geo, { ...FLAT, cornerMode: "pillared", cornerSize: s });
    const quarter = (s * s) / 4;
    assert.ok(Math.abs(rectPlain.stats.volume - rect.stats.volume - 4 * quarter * H) < 1e-2, `rectangle removed ${rectPlain.stats.volume - rect.stats.volume}`);
    const ellPlain = dungeonShell(ELL, geo, FLAT);
    const ell = dungeonShell(ELL, geo, { ...FLAT, cornerMode: "pillared", cornerSize: s });
    assert.ok(Math.abs(ellPlain.stats.volume - ell.stats.volume - (5 * quarter + 3 * quarter) * H) < 1e-2, `L removed ${ellPlain.stats.volume - ell.stats.volume}`);
    assert.equal(diagonalWalls(ell), 0, "pillars are square");
  });

  it("the floor area the bake reports is the painted floor, whatever the corners", () => {
    const plain = dungeonShell(RECT, geo, FLAT);
    const cut = dungeonShell(RECT, geo, { ...FLAT, cornerMode: "chamfered" });
    assert.equal(cut.stats.floorArea, plain.stats.floorArea);
  });

  it("the theme carries cornerMode and cornerSize, and refuses a bad mode or a size outside 0.1..1 m", () => {
    const t = parseShellTheme({ cornerMode: "pillared", cornerSize: 0.4 });
    const o = shellOptionsOf(t);
    assert.equal(o.cornerMode, "pillared");
    assert.equal(o.cornerSize, 0.4);
    assert.equal(parseShellTheme({}).cornerMode, "square");
    assert.throws(() => parseShellTheme({ cornerMode: "rounded" }));
    assert.throws(() => parseShellTheme({ cornerSize: 0 }));
    assert.throws(() => parseShellTheme({ cornerSize: 3 }));
  });
});
