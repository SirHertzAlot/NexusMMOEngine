/**
 * Portal kinds: door, arc, corridor and stair. Each kind is accepted on a
 * wall beside floor, is cut open in the grid the shell reads, and is listed
 * as a portal entity on that same cell. Unknown kinds are refused.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { CELL } from "../src/generate.js";
import { dungeonFromLayout, layoutPortals, parseLayoutMask, PORTAL_KINDS, dungeonShell, type GeometryOps } from "../src/index.js";

const require = createRequire(import.meta.url);
const geo = require("@mmo-engine/addon-geometry") as GeometryOps;

const ROWS = ["#########", "#.......#", "#.......#", "#.......#", "#########"];

describe("portal kinds", () => {
  for (const kind of PORTAL_KINDS) {
    it(`a ${kind} is cut open on its wall cell, listed with its kind, and opens the shell there`, () => {
      // A wall cell at (0, 2) is beside floor (1, 2); the opening runs east-west.
      const layout = parseLayoutMask({ version: 1, rows: ROWS, entrance: { x: 2, y: 2 }, portals: [{ id: `${kind}-1`, x: 0, y: 2, side: "x", kind }] });
      const d = dungeonFromLayout(layout);
      assert.equal(d.grid[2 * 9 + 0], CELL.floor, "the portal cell is cut open");
      const [p] = layoutPortals(layout);
      assert.deepEqual({ id: p.id, x: p.x, y: p.y, kind: p.kind }, { id: `${kind}-1`, x: 0, y: 2, kind });
      const s = dungeonShell(d, geo);
      assert.ok(s.stats.triangles > 0, "the shell builds around the opening");
    });
  }

  it("a portal with no kind is a door", () => {
    const layout = parseLayoutMask({ version: 1, rows: ROWS, entrance: { x: 2, y: 2 }, portals: [{ id: "d", x: 0, y: 2, side: "x" }] });
    assert.equal(layoutPortals(layout)[0].kind, "door");
  });

  it("refuses an unknown kind", () => {
    assert.throws(() => parseLayoutMask({ version: 1, rows: ROWS, entrance: { x: 2, y: 2 }, portals: [{ id: "x", x: 0, y: 2, side: "x", kind: "hatch" }] }));
  });
});
