/**
 * tool-store: the toolbar's shared viewport tool (select/move/rotate/scale).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTool, setTool, subscribeTool } from "../src/ui/tool-store.js";

describe("tool-store", () => {
  it("starts on select", () => {
    setTool("select");
    assert.equal(getTool(), "select");
  });

  it("set/get round-trips the toolbar ids", () => {
    for (const t of ["select", "move", "rotate", "scale"]) {
      setTool(t);
      assert.equal(getTool(), t);
    }
    setTool("select");
  });

  it("notifies subscribers on change, once per change", () => {
    setTool("select");
    let calls = 0;
    const unsub = subscribeTool(() => calls++);
    setTool("move");
    setTool("move");
    assert.equal(calls, 1);
    setTool("rotate");
    assert.equal(calls, 2);
    unsub();
    setTool("select");
    assert.equal(calls, 2);
  });

  it("unsubscribe stops notifications", () => {
    setTool("select");
    let calls = 0;
    const unsub = subscribeTool(() => calls++);
    unsub();
    setTool("scale");
    assert.equal(calls, 0);
    setTool("select");
  });
});
