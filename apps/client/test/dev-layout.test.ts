/**
 * The dev HUD's layout: panels stay grabbable on screen whatever the
 * window, and the stored layout is read defensively (unknown panels
 * dropped, missing or damaged ones defaulted, storage that throws
 * ignored).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampPanel, loadLayout, MIN_OPACITY, MIN_W, saveLayout, type DevLayout, type PanelLayout } from "../src/ui/dev-layout.js";

const VP = { width: 1280, height: 720 };
const P: PanelLayout = { x: 16, y: 16, w: 320, h: null, opacity: 0.9, open: true, collapsed: false };
const DEFAULTS: DevLayout = { hidden: false, panels: { status: P, perf: { ...P, y: 100 } } };

function memory(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  } as unknown as Storage & { data: Map<string, string> };
}

describe("dev HUD layout", () => {
  it("keeps a panel's title bar on screen and its size and opacity in range", () => {
    assert.deepEqual(clampPanel(P, VP), P, "a panel in range is left alone");
    const off = clampPanel({ ...P, x: 5000, y: -40, w: 40, opacity: 0 }, VP);
    assert.equal(off.w, MIN_W);
    assert.equal(off.x, VP.width - 48, "part of it still on screen to grab");
    assert.equal(off.y, 0, "never above the top");
    assert.equal(off.opacity, MIN_OPACITY);
    assert.equal(clampPanel({ ...P, x: -1000 }, VP).x, 48 - P.w);
    assert.equal(clampPanel({ ...P, w: 4000, h: 4000 }, VP).h, VP.height);
  });

  it("round-trips through storage", () => {
    const store = memory();
    const moved: DevLayout = { hidden: true, panels: { ...DEFAULTS.panels, perf: { ...P, x: 600, h: 240, opacity: 0.4, collapsed: true } } };
    saveLayout(store, moved);
    assert.deepEqual(loadLayout(store, DEFAULTS), moved);
  });

  it("defaults what is missing or damaged, and drops panels that no longer exist", () => {
    const store = memory();
    store.setItem("mmo.devhud.v1", JSON.stringify({ hidden: "yes", panels: { status: { ...P, x: "left" }, gone: P } }));
    assert.deepEqual(loadLayout(store, DEFAULTS), DEFAULTS);
    store.setItem("mmo.devhud.v1", "{not json");
    assert.deepEqual(loadLayout(store, DEFAULTS), DEFAULTS);
    assert.deepEqual(loadLayout(null, DEFAULTS), DEFAULTS);
  });

  it("survives storage that refuses (private windows)", () => {
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    assert.deepEqual(loadLayout(refusing, DEFAULTS), DEFAULTS);
    assert.doesNotThrow(() => saveLayout(refusing, DEFAULTS));
  });
});
