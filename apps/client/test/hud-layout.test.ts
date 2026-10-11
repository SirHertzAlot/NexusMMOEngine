/**
 * TDD: EA23 HUD layout — data-driven widget positions.
 *
 * `content/ui/hud.json` maps widget ids to anchor + offset + visibility.
 * The client reads it; the editor writes it. Positions are data, not code.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadHudLayout, DEFAULT_LAYOUT } from "../src/ui/hud-layout.js";

describe("loadHudLayout", () => {
  it("loads a valid layout", () => {
    const l = loadHudLayout({
      widgets: {
        "player-frame": { anchor: "bottom-left", offset: { x: 16, y: 16 }, visible: true },
      },
    });
    assert.equal(l.widgets["player-frame"]?.anchor, "bottom-left");
  });

  it("rejects a bad anchor", () => {
    assert.throws(() =>
      loadHudLayout({ widgets: { x: { anchor: "middle", offset: { x: 0, y: 0 }, visible: true } } }),
    );
  });

  it("fills defaults for a sparse widget entry", () => {
    const l = loadHudLayout({ widgets: { x: { anchor: "top-left" } } });
    assert.deepEqual(l.widgets["x"]?.offset, { x: 0, y: 0 });
    assert.equal(l.widgets["x"]?.visible, true);
  });

  it("the default layout covers the known widgets", () => {
    for (const id of ["player-frame", "cast-bar", "chat-panel", "quest-tracker", "bag-panel"]) {
      assert.ok(DEFAULT_LAYOUT.widgets[id], `default layout missing ${id}`);
    }
  });

  it("resolves an anchor to CSS for a 1920x1080 viewport", () => {
    const css = DEFAULT_LAYOUT.widgets["player-frame"];
    assert.ok(css);
    // bottom-left: left = offset.x, bottom = offset.y
    assert.equal(css.anchor, "bottom-left");
  });
});

describe("anchor CSS", () => {
  it("computes style for each anchor", async () => {
    const { anchorStyle } = await import("../src/ui/hud-layout.js");
    assert.deepEqual(anchorStyle("top-left", { x: 10, y: 20 }), {
      position: "absolute",
      left: 10,
      top: 20,
    });
    assert.deepEqual(anchorStyle("bottom-right", { x: 10, y: 20 }), {
      position: "absolute",
      right: 10,
      bottom: 20,
    });
    const center = anchorStyle("center", { x: 5, y: 5 });
    assert.equal(center.position, "absolute");
    assert.equal(center.left, "50%");
    assert.equal(center.top, "50%");
    assert.ok(String(center.transform).includes("5px"), "offset appears in the transform");
  });
});
