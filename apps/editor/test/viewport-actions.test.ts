/**
 * ViewportActions: the View menu's Zoom/Reset target. Viewports register
 * while mounted; with nothing registered the menu disables with a reason.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearViewportActions,
  getViewportActions,
  registerViewportActions,
  subscribeViewportActions,
  type ViewportActions,
} from "../src/ui/viewport-actions.js";

function viewport(label = "test viewport"): ViewportActions {
  return {
    label,
    canZoomIn: true,
    canZoomOut: true,
    canReset: true,
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    reset: () => undefined,
  };
}

describe("viewport actions", () => {
  it("starts with nothing registered", () => {
    assert.equal(getViewportActions(), null);
  });

  it("register makes it current, clear removes it", () => {
    const v = viewport();
    registerViewportActions(v);
    assert.equal(getViewportActions(), v);
    clearViewportActions(v);
    assert.equal(getViewportActions(), null);
  });

  it("clear only removes the matching registration", () => {
    const a = viewport("a");
    const b = viewport("b");
    registerViewportActions(a);
    clearViewportActions(b);
    assert.equal(getViewportActions(), a);
    clearViewportActions(a);
    assert.equal(getViewportActions(), null);
  });

  it("notifies subscribers on register and clear", () => {
    const v = viewport();
    let calls = 0;
    const stop = subscribeViewportActions(() => calls++);
    try {
      registerViewportActions(v);
      clearViewportActions(v);
      assert.equal(calls, 2);
    } finally {
      stop();
    }
  });
});
