/**
 * Shortcut resolver + focus guard (#3): every advertised shortcut either
 * runs (with a typing guard + preventDefault in App.tsx) or loses its hint.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEditorShortcut,
  shouldSkipShortcut,
} from "../src/ui/shortcuts.js";

function target(tag: string, extra: Record<string, unknown> = {}): EventTarget {
  return { tagName: tag, isContentEditable: false, getAttribute: () => null, ...extra } as unknown as EventTarget;
}

describe("shouldSkipShortcut", () => {
  it("skips typing targets", () => {
    assert.equal(shouldSkipShortcut(target("INPUT")), true);
    assert.equal(shouldSkipShortcut(target("TEXTAREA")), true);
    assert.equal(shouldSkipShortcut(target("SELECT")), true);
    assert.equal(shouldSkipShortcut(target("input")), true);
  });

  it("skips contentEditable elements", () => {
    assert.equal(shouldSkipShortcut(target("DIV", { isContentEditable: true })), true);
    assert.equal(
      shouldSkipShortcut(target("DIV", { getAttribute: () => "true" })),
      true,
    );
  });

  it("does not skip buttons, the body, or a missing target", () => {
    assert.equal(shouldSkipShortcut(target("BUTTON")), false);
    assert.equal(shouldSkipShortcut(target("BODY")), false);
    assert.equal(shouldSkipShortcut(target("DIV")), false);
    assert.equal(shouldSkipShortcut(null), false);
    assert.equal(shouldSkipShortcut(undefined), false);
  });
});

describe("resolveEditorShortcut", () => {
  it("maps F5 to play and Shift+F5 to stop", () => {
    assert.equal(resolveEditorShortcut({ key: "F5" }), "play");
    assert.equal(resolveEditorShortcut({ key: "F5", shiftKey: true }), "stop");
  });

  it("leaves modified F5 to the browser (reload / hard reload)", () => {
    assert.equal(resolveEditorShortcut({ key: "F5", ctrlKey: true }), null);
    assert.equal(resolveEditorShortcut({ key: "F5", metaKey: true }), null);
    assert.equal(resolveEditorShortcut({ key: "F5", altKey: true }), null);
  });

  it("maps V/W/E/R (either case) to viewport tools", () => {
    assert.equal(resolveEditorShortcut({ key: "v" }), "tool-select");
    assert.equal(resolveEditorShortcut({ key: "V" }), "tool-select");
    assert.equal(resolveEditorShortcut({ key: "w" }), "tool-move");
    assert.equal(resolveEditorShortcut({ key: "W" }), "tool-move");
    assert.equal(resolveEditorShortcut({ key: "e" }), "tool-rotate");
    assert.equal(resolveEditorShortcut({ key: "E" }), "tool-rotate");
    assert.equal(resolveEditorShortcut({ key: "r" }), "tool-scale");
    assert.equal(resolveEditorShortcut({ key: "R" }), "tool-scale");
  });

  it("ignores modified or unrelated keys (Ctrl+V stays paste)", () => {
    assert.equal(resolveEditorShortcut({ key: "v", ctrlKey: true }), null);
    assert.equal(resolveEditorShortcut({ key: "c", metaKey: true }), null);
    assert.equal(resolveEditorShortcut({ key: "v", altKey: true }), null);
    assert.equal(resolveEditorShortcut({ key: "w", shiftKey: true }), null);
    assert.equal(resolveEditorShortcut({ key: "x" }), null);
    assert.equal(resolveEditorShortcut({ key: "Enter" }), null);
    assert.equal(resolveEditorShortcut({ key: "Escape" }), null);
  });
});
