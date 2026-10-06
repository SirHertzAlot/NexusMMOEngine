import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EditorSelectionModel } from "../src/ui/editor-selection.js";

describe("EditorSelectionModel", () => {
  it("shares a component decomposition and notifies readers", () => {
    const model = new EditorSelectionModel();
    let notifications = 0;
    const unsubscribe = model.subscribe(() => notifications++);
    model.select({
      source: "entity-list",
      kind: "entity",
      id: "42",
      label: "E42",
      components: [{ name: "health", fields: [{ key: "current", value: "80" }] }],
    });

    assert.equal(notifications, 1);
    assert.deepEqual(model.get(), {
      source: "entity-list",
      kind: "entity",
      id: "42",
      label: "E42",
      components: [{ name: "health", fields: [{ key: "current", value: "80" }] }],
    });
    unsubscribe();
  });

  it("only clears a selection owned by the requested source", () => {
    const model = new EditorSelectionModel();
    model.select({ source: "outliner", kind: "region", id: "0,0", label: "Region 0,0", components: [] });
    model.clear("viewport");
    assert.equal(model.get()?.id, "0,0");
    model.clear("outliner");
    assert.equal(model.get(), null);
  });
});
