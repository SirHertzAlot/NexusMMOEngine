/** viewport-bus: the toolbar and View menu act on the registered viewport and say why they cannot. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  flagBlocked,
  getViewport,
  getViewportFlags,
  registerViewport,
  runViewportCommand,
  setViewportFlag,
  subscribeViewport,
  toggleViewportFlag,
  viewportBlocked,
} from "../src/ui/viewport-bus.js";

describe("viewport-bus", () => {
  it("blocks everything with no viewport", () => {
    assert.equal(getViewport(), null);
    assert.match(viewportBlocked("zoom-in") ?? "", /no 3D viewport/);
    assert.match(flagBlocked("grid") ?? "", /no 3D viewport/);
  });

  it("zoom and reset reach the registered viewport", () => {
    const calls: string[] = [];
    const off = registerViewport({
      label: "scene viewport",
      supports: { grid: true, gizmos: true, wireframe: true },
      zoom: (f) => calls.push(`zoom ${f}`),
      reset: () => calls.push("reset"),
      screenshot: async () => null,
    });
    runViewportCommand("zoom-in");
    runViewportCommand("zoom-out");
    runViewportCommand("reset");
    assert.deepEqual(calls, ["zoom 1.25", "zoom 0.8", "reset"]);
    assert.equal(flagBlocked("grid"), null);
    off();
    assert.equal(getViewport(), null);
  });

  it("a viewport that owns its camera or lacks a toggle says so", () => {
    const off = registerViewport({ label: "game view", supports: { wireframe: true }, screenshot: async () => null });
    assert.match(viewportBlocked("zoom-in") ?? "", /owns its camera/);
    assert.match(flagBlocked("grid") ?? "", /has no grid/);
    assert.equal(flagBlocked("wireframe"), null);
    off();
  });

  it("a stale unregister keeps the newer viewport", () => {
    const a = registerViewport({ label: "a", supports: {}, screenshot: async () => null });
    const off = registerViewport({ label: "b", supports: {}, screenshot: async () => null });
    a();
    assert.equal(getViewport()?.label, "b");
    off();
  });

  it("flags notify only on change", () => {
    let n = 0;
    const unsub = subscribeViewport(() => n++);
    setViewportFlag("wireframe", true);
    setViewportFlag("wireframe", true);
    toggleViewportFlag("wireframe");
    assert.equal(n, 2);
    assert.equal(getViewportFlags().wireframe, false);
    unsub();
  });
});
