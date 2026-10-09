import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HUD_CATALOG,
  HUD_RESOLUTIONS,
  HUD_SCALES,
  anchorCss,
  hexToHsl,
  hudProblems,
  hudReport,
  moveHudWidget,
  reanchorHudWidget,
  themeVars,
  validateHud,
  widgetRect,
  type HudDoc,
  type HudWidget,
} from "../src/index.js";

const game = (): HudDoc => JSON.parse(readFileSync(new URL("../../../../content/ui/hud.json", import.meta.url), "utf8")) as HudDoc;
const vp = { w: 1920, h: 1080 };

describe("widgetRect", () => {
  it("places each anchor from its edge, scaled", () => {
    const w = (anchor: HudWidget["anchor"]): HudWidget => ({ anchor, x: 10, y: 20, w: 100, h: 50 });
    assert.deepEqual(widgetRect(w("top-left"), vp, 100), { x: 10, y: 20, w: 100, h: 50 });
    assert.deepEqual(widgetRect(w("bottom-right"), vp, 100), { x: 1920 - 10 - 100, y: 1080 - 20 - 50, w: 100, h: 50 });
    assert.deepEqual(widgetRect(w("center"), vp, 100), { x: 960 - 50 + 10, y: 540 - 25 + 20, w: 100, h: 50 });
    assert.deepEqual(widgetRect(w("top"), vp, 125), { x: 960 - 62.5 + 12.5, y: 25, w: 125, h: 62.5 });
  });
  it("css pins the same box", () => {
    assert.deepEqual(anchorCss({ anchor: "bottom-right", x: 16, y: 32, w: 160, h: 48 }), { right: "1rem", bottom: "2rem", width: "10rem", height: "3rem" });
    const mid = anchorCss({ anchor: "top", x: 0, y: 16, w: 256, h: 64 });
    assert.equal(mid.left, "calc(50% + 0rem)");
    assert.equal(mid.top, "1rem");
    assert.equal(mid.transform, "translateX(-50%)");
  });
});

describe("editing", () => {
  it("a drag moves toward the dragged side whatever the anchor", () => {
    const right: HudWidget = { anchor: "bottom-right", x: 16, y: 16, w: 100, h: 50 };
    assert.deepEqual(moveHudWidget(right, 10, 4, 100), { ...right, x: 6, y: 12 });
    const mid: HudWidget = { anchor: "top", x: 0, y: 16, w: 100, h: 50 };
    assert.deepEqual(moveHudWidget(mid, 10, 4, 100), { ...mid, x: 10, y: 20 });
    assert.equal(moveHudWidget(mid, 25, 0, 125).x, 20);
  });
  it("re-anchoring keeps the box where it is", () => {
    const w: HudWidget = { anchor: "top-left", x: 40, y: 30, w: 100, h: 50 };
    for (const a of ["top", "bottom-right", "center", "left", "bottom-left"] as const) {
      for (const scale of [100, 125]) {
        const n = reanchorHudWidget(w, a, vp, scale);
        assert.equal(n.anchor, a);
        const before = widgetRect(w, vp, scale);
        const after = widgetRect(n, vp, scale);
        for (const k of ["x", "y", "w", "h"] as const) assert.ok(Math.abs(before[k] - after[k]) < 0.5, `${a} ${scale} ${k}`);
      }
    }
  });
});

describe("hud checks", () => {
  const doc = (widgets: Record<string, HudWidget>): HudDoc => ({ version: 1, theme: {}, widgets });
  it("flags overlapping and off-screen widgets", () => {
    const d = doc({
      "player-frame": { anchor: "top-left", x: 0, y: 0, w: 100, h: 100 },
      chat: { anchor: "top-left", x: 50, y: 50, w: 100, h: 100 },
      settings: { anchor: "top-right", x: -20, y: 0, w: 100, h: 30 },
      "party-frame": { anchor: "top-left", x: 100, y: 40, w: 50, h: 30 },
    });
    const p = hudProblems(d, vp, 100);
    assert.deepEqual(p.overlaps, [["chat", "party-frame"], ["chat", "player-frame"]].sort());
    assert.deepEqual(p.offscreen, ["settings"]);
  });
  it("hidden widgets are ignored", () => {
    const d = doc({
      a: { anchor: "top-left", x: 0, y: 0, w: 100, h: 100 },
      b: { anchor: "top-left", x: 0, y: 0, w: 100, h: 100, visible: false },
    });
    assert.deepEqual(hudProblems(d, vp, 100).overlaps, []);
  });
  it("a small screen at 125% overlaps what 1080p does not", () => {
    const d = doc({
      a: { anchor: "top-left", x: 0, y: 0, w: 300, h: 50 },
      b: { anchor: "top-right", x: 0, y: 0, w: 300, h: 50 },
    });
    assert.deepEqual(hudProblems(d, { w: 700, h: 720 }, 100).overlaps, []);
    assert.deepEqual(hudProblems(d, { w: 700, h: 720 }, 125).overlaps, [["a", "b"]]);
    assert.equal(hudReport(d).length, HUD_RESOLUTIONS.length * HUD_SCALES.length);
  });
  it("validates shape, ids, anchors, numbers and theme", () => {
    assert.deepEqual(validateHud(game()), []);
    const bad = { version: 2, theme: { card: "red", nope: "#fff" }, widgets: { ghost: { anchor: "up", x: "1", y: 0, w: -1, h: 0 }, chat: { anchor: "up", x: "1", y: 0, w: -1, h: 0 } } };
    const paths = validateHud(bad).map((i) => i.path).sort();
    assert.deepEqual(
      paths,
      ["theme.card", "theme.nope", "version", "widgets.ghost", "widgets.chat.anchor", "widgets.chat.h", "widgets.chat.w", "widgets.chat.x"].sort(),
    );
    assert.equal(validateHud(null)[0].path, "");
  });
  it("ships every catalog widget, clean at the common resolutions at 100%", () => {
    const d = game();
    assert.deepEqual(Object.keys(d.widgets).sort(), HUD_CATALOG.map((c) => c.id).sort());
    for (const r of HUD_RESOLUTIONS) {
      const p = hudProblems(d, r, 100);
      assert.deepEqual(p.overlaps, [], `${r.w}x${r.h}`);
      assert.deepEqual(p.offscreen, [], `${r.w}x${r.h}`);
    }
  });
});

describe("theme", () => {
  it("turns hex tokens into the client's bare hsl channels", () => {
    assert.equal(hexToHsl("#ffffff"), "0 0% 100%");
    assert.equal(hexToHsl("#000000"), "0 0% 0%");
    assert.equal(hexToHsl("#ff0000"), "0 100% 50%");
    assert.deepEqual(themeVars({ card: "#ff0000", primary: "#00ff00" }), { "--card": "0 100% 50%", "--primary": "120 100% 50%" });
  });
});
