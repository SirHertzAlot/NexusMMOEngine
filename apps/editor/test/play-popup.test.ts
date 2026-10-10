/**
 * TDD: Play "New window" popup helpers.
 *
 * Pure functions for the pop-out game view (no DOM): the window features
 * string, the popup shell HTML (with keyboard forwarding so WASD keeps
 * driving the avatar), and feature detection. The DOM orchestration
 * (adoptNode, restore) lives in popOutGameView() beside them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPopupShell,
  canPopOut,
  escapeHtml,
  popupFeatures,
  POPUP_MOUNT_ID,
  POPUP_NAME,
} from "../src/ui/play-popup.js";

describe("popupFeatures", () => {
  it("includes the requested size", () => {
    const f = popupFeatures(1280, 800);
    assert.ok(f.includes("width=1280"));
    assert.ok(f.includes("height=800"));
  });

  it("disables browser chrome", () => {
    const f = popupFeatures(1280, 800);
    assert.ok(f.includes("menubar=no"));
    assert.ok(f.includes("toolbar=no"));
  });
});

describe("escapeHtml", () => {
  it("escapes angle brackets and quotes", () => {
    assert.equal(escapeHtml(`<script>"x"</script>`), "&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
  });

  it("escapes ampersands first", () => {
    assert.equal(escapeHtml("a&b"), "a&amp;b");
  });
});

describe("buildPopupShell", () => {
  it("is a complete HTML document with the mount point", () => {
    const html = buildPopupShell("Play — world");
    assert.ok(html.includes("<!DOCTYPE html>"));
    assert.ok(html.includes(`id="${POPUP_MOUNT_ID}"`));
    assert.ok(html.includes("Play — world"));
  });

  it("escapes the title", () => {
    const html = buildPopupShell(`</title><script>`);
    assert.ok(!html.includes("</title><script>"));
    assert.ok(html.includes("&lt;/title&gt;"));
  });

  it("forwards keyboard events to the opener", () => {
    const html = buildPopupShell("t");
    assert.ok(html.includes("keydown"));
    assert.ok(html.includes("keyup"));
    assert.ok(html.includes("window.opener"));
  });

  it("notifies the opener on close", () => {
    const html = buildPopupShell("t");
    assert.ok(html.includes("beforeunload") || html.includes("unload"));
  });
});

describe("canPopOut", () => {
  it("is false without a browser window (node)", () => {
    assert.equal(canPopOut(), false);
  });

  it("detects window.open via injected global", () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g["window"];
    g["window"] = { open: () => null };
    try {
      assert.equal(canPopOut(), true);
    } finally {
      if (prev === undefined) delete g["window"];
      else g["window"] = prev;
    }
  });
});

describe("constants", () => {
  it("popup name is stable (reopening focuses the same popup)", () => {
    assert.equal(POPUP_NAME, "mmo-editor-play");
  });
});
