import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffRows } from "../src/gameplay-diff.js";
import { TABLE_DEFS } from "../src/gameplay-tables.js";
import type { GridContext, GridRow } from "../src/gameplay-grid.js";

const def = TABLE_DEFS.creatures;
const ctx: GridContext = { refs: { items: [], creatures: [] }, options: {} };
const row = (id: string, data: Record<string, unknown>): GridRow => ({ id, data });

describe("diffRows", () => {
  const saved = [row("goblin", { name: "Goblin", health: 55 }), row("ogre", { name: "Ogre", health: 480 })];

  it("reports nothing when nothing changed", () => {
    assert.deepEqual(diffRows(saved, saved, def.columns, ctx), []);
  });

  it("lists an edited cell as before → after", () => {
    const now = [row("goblin", { name: "Goblin", health: 60 }), saved[1]];
    assert.deepEqual(
      diffRows(saved, now, def.columns, ctx).filter((c) => c.kind === "edit"),
      [{ kind: "edit", path: "goblin.health", change: "55 → 60" }],
    );
  });

  it("lists added and removed rows", () => {
    const now = [saved[0], row("wolf", { name: "Wolf", health: 40 })];
    const out = diffRows(saved, now, def.columns, ctx);
    assert.ok(out.some((c) => c.kind === "remove" && c.path === "ogre"));
    assert.ok(out.some((c) => c.kind === "add" && c.path === "wolf"));
  });

  it("marks a cell the checks reject, once, with the check's own text", () => {
    const now = [saved[0], row("ogre", { name: "Ogre", health: -40 })];
    const errs = diffRows(saved, now, def.columns, ctx).filter((c) => c.kind === "error");
    assert.equal(errs.length, 1);
    assert.equal(errs[0].path, "ogre.health");
    assert.notEqual(errs[0].change, "");
  });

  it("shows a cleared cell as the default", () => {
    const now = [row("goblin", { name: "Goblin" }), saved[1]];
    const edit = diffRows(saved, now, def.columns, ctx).find((c) => c.path === "goblin.health");
    assert.equal(edit?.change, "55 → (default)");
  });

  it("leaves a problem already in the saved file out (it is not an unsaved change)", () => {
    const bad = [row("goblin", { name: "Goblin", health: 55 }), row("ogre", { name: "Ogre", health: -40 })];
    assert.deepEqual(diffRows(bad, bad, def.columns, ctx), []);
  });

  it("checks every cell of an added row", () => {
    const now = [...saved, row("imp", { name: "Imp", health: -1 })];
    assert.ok(diffRows(saved, now, def.columns, ctx).some((c) => c.kind === "error" && c.path === "imp.health"));
  });
});
