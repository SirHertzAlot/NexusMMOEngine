/** doc-io: import refuses non-JSON and wrong-shaped files before the panel sees them. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyImportText, checkImportShape, exportFileName, parseJsonText } from "../src/ui/doc-io.js";
import type { DocActions } from "../src/ui/doc-actions.js";

function doc(current: unknown, onImport: (v: unknown) => void | Promise<void>): DocActions {
  return {
    label: 'scene "a"',
    canSave: false,
    canUndo: false,
    canRedo: false,
    save: () => undefined,
    undo: () => undefined,
    redo: () => undefined,
    exportDoc: () => ({ name: "a", data: current }),
    importDoc: onImport,
  };
}

describe("doc-io", () => {
  it("parseJsonText names the file when the text is not JSON", () => {
    assert.throws(() => parseJsonText("{nope", "x.json"), /x\.json: not valid JSON/);
    assert.deepEqual(parseJsonText('{"a":1}'), { a: 1 });
  });

  it("checkImportShape compares kind and top-level keys", () => {
    assert.equal(checkImportShape({ a: 1, b: 2 }, { a: 9, b: 8, c: 7 }), null);
    assert.match(checkImportShape({ a: 1, b: 2 }, { a: 1 }) ?? "", /missing key "b"/);
    assert.match(checkImportShape({ a: 1 }, [1]) ?? "", /expected object but the file holds array/);
    assert.equal(checkImportShape([1], []), null);
    assert.match(checkImportShape([1], "x") ?? "", /expected array/);
  });

  it("applyImportText hands a valid file to the panel and refuses the rest without touching it", async () => {
    const got: unknown[] = [];
    const d = doc({ name: "a", nodes: [] }, (v) => void got.push(v));
    await applyImportText(d, '{"name":"b","nodes":[1]}', "b.json");
    assert.deepEqual(got, [{ name: "b", nodes: [1] }]);
    await assert.rejects(applyImportText(d, "garbage", "g.json"), /not valid JSON/);
    await assert.rejects(applyImportText(d, '{"name":"b"}', "b.json"), /missing key "nodes"/);
    await assert.rejects(applyImportText(d, "[]", "b.json"), /expected object/);
    assert.equal(got.length, 1);
  });

  it("a panel's own refusal (sync or async) propagates and a doc without import is refused", async () => {
    const d = doc({ a: 1 }, () => {
      throw new Error("scene: 3 problems");
    });
    await assert.rejects(applyImportText(d, '{"a":2}'), /3 problems/);
    const later = doc({ a: 1 }, async () => {
      throw new Error("server said no");
    });
    await assert.rejects(applyImportText(later, '{"a":2}'), /server said no/);
    const none = { ...d, importDoc: undefined };
    await assert.rejects(applyImportText(none, "{}"), /cannot be imported/);
  });

  it("export file names are safe", () => {
    assert.equal(exportFileName('scene "arena 01"'), "scene-arena-01-.json");
    assert.equal(exportFileName("game.flow"), "game.flow.json");
  });
});
