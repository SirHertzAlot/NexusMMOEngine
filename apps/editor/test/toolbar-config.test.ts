import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TOOLBAR, isShown, loadToolbar, parseToolbar, saveToolbar, toggleGroup } from "../src/toolbar-config.js";

test("toggleGroup hides then shows a group", () => {
  const off = toggleGroup(DEFAULT_TOOLBAR, "tick");
  assert.equal(isShown(off, "tick"), false);
  assert.equal(isShown(toggleGroup(off, "tick"), "tick"), true);
});

test("parseToolbar drops unknown groups and survives bad input", () => {
  assert.deepEqual(parseToolbar('{"hidden":["tick","nope",3],"iconsOnly":true}'), { hidden: ["tick"], iconsOnly: true });
  assert.deepEqual(parseToolbar("{not json"), DEFAULT_TOOLBAR);
  assert.deepEqual(parseToolbar(null), DEFAULT_TOOLBAR);
});

test("saved settings load back", () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  saveToolbar({ hidden: ["layout"], iconsOnly: true }, storage);
  assert.deepEqual(loadToolbar(storage), { hidden: ["layout"], iconsOnly: true });
});
