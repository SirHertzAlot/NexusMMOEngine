/**
 * The bake document's host routes, end to end: an op applied through the
 * op route, then a bake through the bake route, and the view shows the edit.
 * Refused ops and bakes come back as BakeDocError with the reason.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bakeRoute, BakeDocError, docOpRoute, loadGeometry } from "../src/bake-doc-host.js";
import { emptyDoc } from "../src/inspectors/dungeon-bake-doc.js";

const NOW = new Date("2026-11-12T21:00:00.000Z");
const CELL_AREA = 4;

describe("bake document host routes", () => {
  it("a paint through the op route shows in the bake through the bake route", () => {
    const geo = loadGeometry();
    const before = bakeRoute({ doc: emptyDoc("crypt-a"), why: "baseline" }, geo, NOW).view;
    const { doc } = docOpRoute({ doc: emptyDoc("crypt-a"), op: { op: "paint", x: 4, y: 0, cell: "." } });
    const after = bakeRoute({ doc, why: "paint" }, geo, NOW).view;
    assert.equal(after.floorArea - before.floorArea, CELL_AREA);
  });

  it("a portal placed through the op route shows in the view with its kind", () => {
    const geo = loadGeometry();
    const { doc } = docOpRoute({ doc: emptyDoc("crypt-b"), op: { op: "placePortal", portal: { id: "st", x: 8, y: 2, side: "x", kind: "stair" } } });
    const { view } = bakeRoute({ doc, why: "portal" }, geo, NOW);
    assert.deepEqual(view.portals, [{ id: "st", kind: "stair", x: 8, y: 2 }]);
  });

  it("the provenance is stamped with the request's time and reason", () => {
    const { provenance } = bakeRoute({ doc: emptyDoc("crypt-c"), why: "check" }, loadGeometry(), NOW);
    assert.equal(provenance.when, NOW.toISOString());
    assert.equal(provenance.why, "check");
    assert.equal(provenance.who, "editor");
  });

  it("a refused op comes back as BakeDocError with the reason", () => {
    assert.throws(() => docOpRoute({ doc: emptyDoc("x"), op: { op: "paint", x: 1, y: 1, cell: "#" } }), (e: unknown) => e instanceof BakeDocError && /entrance must stay floor/.test((e as Error).message));
  });

  it("a request without a doc or an op is refused", () => {
    assert.throws(() => docOpRoute({ op: { op: "setTheme", theme: "dry-crypt" } }), BakeDocError);
    assert.throws(() => docOpRoute({ doc: emptyDoc("x") }), BakeDocError);
    assert.throws(() => bakeRoute({}, loadGeometry(), NOW), BakeDocError);
  });
});
