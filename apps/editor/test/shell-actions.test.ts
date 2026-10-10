/** shell-actions: which documents the File menu can import and export, and what counts as unsaved. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { anyUnsaved, canExport, canImport } from "../src/ui/shell-actions.js";
import { clearDocActions, registerDocActions, type DocActions } from "../src/ui/doc-actions.js";

const base: DocActions = {
  label: "x",
  canSave: false,
  canUndo: false,
  canRedo: false,
  save: () => undefined,
  undo: () => undefined,
  redo: () => undefined,
};

describe("shell-actions", () => {
  it("import needs both halves of the JSON form; a panel's own file handling also counts", () => {
    assert.equal(canExport(null), false);
    assert.equal(canImport(null), false);
    assert.equal(canExport(base), false);
    assert.equal(canExport({ ...base, exportDoc: () => ({ name: "a", data: {} }) }), true);
    assert.equal(canImport({ ...base, importDoc: () => undefined }), false);
    assert.equal(canImport({ ...base, importDoc: () => undefined, exportDoc: () => ({ name: "a", data: {} }) }), true);
    assert.equal(canExport({ ...base, canExport: true, exportFile: () => undefined }), true);
    assert.equal(canImport({ ...base, canImport: true, importFile: () => undefined }), true);
    assert.equal(canExport({ ...base, canExport: true }), false);
  });

  it("anyUnsaved follows the open document", () => {
    clearDocActions();
    assert.equal(anyUnsaved(), false);
    registerDocActions({ ...base, canSave: true });
    assert.equal(anyUnsaved(), true);
    clearDocActions();
    assert.equal(anyUnsaved(), false);
  });
});
