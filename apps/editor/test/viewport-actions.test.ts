/**
 * ViewportActions: the View menu's Zoom/Reset target. Viewports register
 * while mounted; with nothing registered the menu disables with a reason.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearViewportActions,
  flagBlocked,
  getViewportActions,
  screenshotBlocked,
  toggleViewportFlag,
  viewportFlags,
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

  it("toggles flip the shared flag and say why they cannot apply without a viewport that has them", () => {
    assert.match(flagBlocked("grid") ?? "", /no 3D viewport/);
    assert.match(screenshotBlocked() ?? "", /no 3D viewport/);
    const v = { ...viewport("game view"), supports: { wireframe: true } };
    registerViewportActions(v);
    try {
      assert.equal(flagBlocked("wireframe"), null);
      assert.match(flagBlocked("grid") ?? "", /game view has no grid/);
      assert.match(screenshotBlocked() ?? "", /cannot take a screenshot/);
      const before = viewportFlags.get().wireframe;
      toggleViewportFlag("wireframe");
      assert.equal(viewportFlags.get().wireframe, !before);
      toggleViewportFlag("wireframe");
      registerViewportActions({ ...v, screenshot: () => Promise.resolve(null) });
      assert.equal(screenshotBlocked(), null);
    } finally {
      registerViewportActions(v);
      clearViewportActions(v);
    }
  });
});
