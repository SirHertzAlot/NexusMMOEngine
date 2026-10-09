/** menu-model: every File / Edit / View row either runs a command or says why it cannot. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DocActions } from "../src/ui/doc-actions.js";
import { editRows, fileRows, viewportOptionRows, zoomRows, type MenuRow, type ShellCommands } from "../src/ui/menu-model.js";
import { registerViewport } from "../src/ui/viewport-bus.js";

const calls: string[] = [];
const run: ShellCommands = {
  newScene: () => calls.push("new"),
  openScene: () => calls.push("open"),
  save: () => calls.push("save"),
  saveAll: () => calls.push("saveAll"),
  revert: () => calls.push("revert"),
  importDoc: () => calls.push("import"),
  exportDoc: () => calls.push("export"),
  undo: () => calls.push("undo"),
  redo: () => calls.push("redo"),
  edit: (c) => calls.push(`edit ${c}`),
};

const doc = (over: Partial<DocActions> = {}): DocActions => ({
  label: 'scene "a"',
  canSave: true,
  canUndo: true,
  canRedo: false,
  save: () => undefined,
  undo: () => undefined,
  redo: () => undefined,
  revert: () => undefined,
  exportDoc: () => ({ name: "a", data: {} }),
  importDoc: () => undefined,
  ...over,
});

const row = (rows: Array<MenuRow | "sep">, label: string): MenuRow => {
  const r = rows.find((x) => x !== "sep" && x.label === label);
  assert.ok(r && r !== "sep", label);
  return r;
};

describe("menu-model", () => {
  it("with no document open, document commands are disabled with a reason; New / Open still run", () => {
    const rows = fileRows(null, false, run);
    for (const l of ["Save", "Save All", "Revert", "Import…", "Export…"]) assert.ok(row(rows, l).disabled, l);
    assert.equal(row(rows, "New Scene").disabled, undefined);
    assert.equal(row(rows, "Open Scene…").disabled, undefined);
    for (const r of editRows(null, run)) if (r !== "sep") assert.ok(r.disabled, r.label);
  });

  it("an open dirty document enables Save, Revert, Import and Export, and each row runs its command", () => {
    calls.length = 0;
    const d = doc();
    const rows = fileRows(d, true, run);
    for (const l of ["Save", "Save All", "Revert", "Import…", "Export…"]) {
      const r = row(rows, l);
      assert.equal(r.disabled, undefined, l);
      r.run?.();
    }
    assert.deepEqual(calls, ["save", "saveAll", "revert", "import", "export"]);
  });

  it("a clean or limited document explains itself", () => {
    const clean = fileRows(doc({ canSave: false }), false, run);
    assert.match(row(clean, "Save").disabled ?? "", /no unsaved changes/);
    assert.match(row(clean, "Revert").disabled ?? "", /no unsaved changes/);
    const limited = fileRows(doc({ revert: undefined, exportDoc: undefined, importDoc: undefined }), false, run);
    assert.match(row(limited, "Revert").disabled ?? "", /does not support Revert/);
    assert.match(row(limited, "Export…").disabled ?? "", /no JSON form/);
    assert.match(row(limited, "Import…").disabled ?? "", /cannot take/);
  });

  it("Undo and Redo follow the document's stacks", () => {
    const rows = editRows(doc({ canUndo: true, canRedo: false }), run);
    assert.equal(row(rows, "Undo").disabled, undefined);
    assert.match(row(rows, "Redo").disabled ?? "", /nothing to redo/);
  });

  it("selection commands exist only where the panel supplies them", () => {
    const plain = editRows(doc(), run);
    assert.match(row(plain, "Copy").disabled ?? "", /no selection commands/);
    const scene = editRows(doc({ edit: { copy: () => undefined, duplicate: () => undefined } }), run);
    assert.equal(row(scene, "Copy").disabled, undefined);
    assert.equal(row(scene, "Duplicate").disabled, undefined);
    assert.match(row(scene, "Paste").disabled ?? "", /copy a node first/);
    assert.match(row(scene, "Cut").disabled ?? "", /select a node first/);
    assert.match(row(scene, "Select All").disabled ?? "", /one item at a time/);
  });

  it("zoom and viewport options follow the registered viewport", () => {
    const flags = { grid: true, gizmos: true, wireframe: false };
    const none = zoomRows({ zoomIn: () => undefined, zoomOut: () => undefined, reset: () => undefined });
    assert.ok(row(none, "Zoom In").disabled);
    assert.ok(row(viewportOptionRows(null, flags, { toggle: () => undefined, screenshot: () => undefined }), "Screenshot viewport").disabled);
    const off = registerViewport({ label: "game view", supports: { wireframe: true }, screenshot: async () => null });
    const vp = viewportOptionRows(
      { label: "game view", supports: { wireframe: true }, screenshot: async () => null },
      flags,
      { toggle: () => undefined, screenshot: () => undefined },
    );
    assert.match(row(vp, "Grid").disabled ?? "", /no grid/);
    assert.equal(row(vp, "Wireframe").disabled, undefined);
    assert.equal(row(vp, "Screenshot viewport").disabled, undefined);
    assert.equal(row(vp, "Grid").checked, true);
    off();
  });
});
