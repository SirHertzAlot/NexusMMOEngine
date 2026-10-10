/** play-shortcuts: parse, capture, validate and match the keys that start saved play setups. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeShortcut, resolveSetupShortcut, shortcutFromEvent, validateShortcut } from "../src/ui/play-shortcuts.js";

describe("play-shortcuts", () => {
  it("normalizes spellings to one canonical chord", () => {
    assert.equal(normalizeShortcut("alt+1"), "Alt+1");
    assert.equal(normalizeShortcut(" shift + CTRL + s "), "Ctrl+Shift+S");
    assert.equal(normalizeShortcut("cmd+f7"), "Meta+F7");
    for (const bad of ["", "+", "Alt+", "Alt+Enter", "Alt+1+2", "Alt", "f13"]) assert.equal(normalizeShortcut(bad), null, bad);
  });

  it("reads a chord from an event, by physical key when given", () => {
    assert.equal(shortcutFromEvent({ key: "1", altKey: true }), "Alt+1");
    assert.equal(shortcutFromEvent({ key: "¡", code: "Digit1", altKey: true }), "Alt+1");
    assert.equal(shortcutFromEvent({ key: "Ω", code: "KeyZ", altKey: true, shiftKey: true }), "Alt+Shift+Z");
    assert.equal(shortcutFromEvent({ key: "F7" }), "F7");
    assert.equal(shortcutFromEvent({ key: "Alt", altKey: true }), null);
    assert.equal(shortcutFromEvent({ key: "Enter" }), null);
  });

  it("allows chords that cannot collide, refuses the rest", () => {
    for (const ok of ["Alt+1", "Alt+Shift+Q", "Ctrl+Shift+1", "F6", "Shift+F8", "Ctrl+Alt+P"]) assert.equal(validateShortcut(ok, []), null, ok);
    for (const bad of ["W", "Ctrl+S", "Shift+A", "F5", "Shift+F5", "F12", "Ctrl+Shift+S", "Alt+F4", "Meta+Alt+1"]) assert.notEqual(validateShortcut(bad, []), null, bad);
  });

  it("refuses a key another setup holds", () => {
    assert.match(validateShortcut("Alt+1", [{ name: "Raid", shortcut: "Alt+1" }]) ?? "", /already starts “Raid”/);
  });

  it("finds the setup an event is bound to", () => {
    const saved = [{ name: "A", shortcut: "Alt+1" }, { name: "B", shortcut: null }, { name: "C", shortcut: "F7" }];
    assert.equal(resolveSetupShortcut({ key: "1", code: "Digit1", altKey: true }, saved)?.name, "A");
    assert.equal(resolveSetupShortcut({ key: "F7" }, saved)?.name, "C");
    assert.equal(resolveSetupShortcut({ key: "1" }, saved), null);
    assert.equal(resolveSetupShortcut({ key: "Shift", shiftKey: true }, saved), null);
  });
});
