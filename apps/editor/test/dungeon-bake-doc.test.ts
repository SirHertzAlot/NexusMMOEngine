/**
 * The dungeon bake document, end to end against the real geometry addon:
 * paint or erase a cell, bake, and the view shows the change; place a portal
 * of each kind and the shell opens there; edit a layer and the dressing
 * follows; bad edits are refused; provenance says what made the bake.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { applyOp, bakeDoc, emptyDoc, type DungeonBakeDoc } from "../src/inspectors/dungeon-bake-doc.js";
import type { GeometryOps } from "@mmo-engine/dungeon";

const require = createRequire(import.meta.url);
const geo = require("@mmo-engine/addon-geometry") as GeometryOps;
const NOW = new Date("2026-11-12T20:00:00.000Z");
const ctx = { who: "tester", why: "test", now: NOW };
const CELL_AREA = 2 * 2; // one layout cell is 2 m by 2 m

const bake = (doc: DungeonBakeDoc) => bakeDoc(doc, geo, ctx);

describe("dungeon bake document", () => {
  it("painting a rock cell into floor adds a cell of floor to the bake", () => {
    const before = bake(emptyDoc("room"));
    const after = bake(applyOp(emptyDoc("room"), { op: "paint", x: 4, y: 0, cell: "." }));
    assert.equal(after.view.floorArea - before.view.floorArea, CELL_AREA, "one more cell of floor");
  });

  it("erasing a floor cell takes a cell of floor from the bake", () => {
    const before = bake(emptyDoc("room"));
    const after = bake(applyOp(emptyDoc("room"), { op: "paint", x: 2, y: 2, cell: "#" }));
    assert.equal(before.view.floorArea - after.view.floorArea, CELL_AREA, "one less cell of floor");
  });

  for (const kind of ["door", "arc", "corridor", "stair"] as const) {
    it(`a ${kind} portal opens its wall cell and shows in the view with its kind`, () => {
      const doc = applyOp(emptyDoc("room"), { op: "placePortal", portal: { id: `${kind}-1`, x: 8, y: 2, side: "x", kind } });
      const b = bake(doc);
      assert.deepEqual(b.view.portals, [{ id: `${kind}-1`, kind, x: 8, y: 2 }]);
      assert.deepEqual(b.bake.portals.map((p) => p.id), [`${kind}-1`]);
      const plain = bake(emptyDoc("room"));
      assert.equal(b.view.floorArea - plain.view.floorArea, CELL_AREA, "the portal cell is cut open in the shell");
    });
  }

  it("setting a layer's budget to zero removes that layer's placements from the bake", () => {
    const doc = applyOp(emptyDoc("room"), { op: "editLayer", layer: "rubble", field: "budget", value: 0 });
    const rubble = bake(doc).view.layers.find((l) => l.layer === "rubble");
    assert.equal(rubble?.placed, 0);
    assert.equal(doc.layerEdits.rubble.budget, 0);
  });

  it("a paint or portal the bake can't use is refused at the edit", () => {
    const doc = emptyDoc("room");
    assert.throws(() => applyOp(doc, { op: "paint", x: 99, y: 0, cell: "." }), /off the/);
    assert.throws(() => applyOp(doc, { op: "paint", x: 1, y: 1, cell: "#" }), /entrance must stay floor/);
    assert.throws(() => applyOp(doc, { op: "setTheme", theme: "lava" }), /not a theme/);
    assert.throws(() => applyOp(doc, { op: "editLayer", layer: "nope", field: "density", value: 0.5 }), /not in/);
    assert.throws(() => applyOp(doc, { op: "editLayer", layer: "rubble", field: "density", value: 2 }), /0 to 1/);
    assert.throws(() => applyOp(doc, { op: "editLayer", layer: "rubble", field: "budget", value: 1.5 }), /whole number/);
    const withPortal = applyOp(doc, { op: "placePortal", portal: { id: "d", x: 8, y: 2, side: "x" } });
    assert.throws(() => applyOp(withPortal, { op: "placePortal", portal: { id: "d", x: 0, y: 2, side: "x" } }), /taken/);
  });

  it("an op returns a new document and leaves the old one as it was", () => {
    const doc = emptyDoc("room");
    const edited = applyOp(doc, { op: "paint", x: 4, y: 0, cell: "." });
    assert.notEqual(edited, doc);
    assert.equal(doc.rows[0][4], "#");
  });

  it("the bake's provenance names what made it", () => {
    const b = bake(emptyDoc("crypt-7"));
    assert.equal(b.provenance.who, "tester");
    assert.equal(b.provenance.where, "crypt-7");
    assert.equal(b.provenance.when, NOW.toISOString());
    assert.equal(b.provenance.how.theme, "dry-crypt");
    assert.ok(b.provenance.how.layers.includes("rubble"));
  });
});
