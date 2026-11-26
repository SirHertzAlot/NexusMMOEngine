/**
 * The bottom dock's regrouping (docs/EDITOR-UI-2026.md §2.6, slice EU5).
 *
 * The styling reference folds eight dock tabs into four. What these
 * assertions protect is that the fold loses nothing: every stream the
 * old tabs carried is still reachable, the validator tab the reference
 * does not have is still there, and a layout saved under one theme
 * opens something real under the other instead of an empty pane.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dockTabs, resolveTab } from "../src/ui/dock-tabs.js";

const ids = (theme: "m3" | "forge", problems = 0): string[] =>
  dockTabs({ theme, problems }).map((t) => t.id);

describe("which tabs each design language shows", () => {
  it("keeps Material 3's three unchanged", () => {
    assert.deepEqual(ids("m3"), ["output", "problems", "bakes"]);
  });

  it("gives forge the reference's grouping", () => {
    assert.deepEqual(ids("forge"), ["console", "problems", "changes", "integrations"]);
  });

  it("folds Output and Bakes into the console rather than dropping them", () => {
    // Both streams are in ui/console-log.ts, so the fold loses no output.
    assert.ok(!ids("forge").includes("output"));
    assert.ok(!ids("forge").includes("bakes"));
    assert.equal(resolveTab(dockTabs({ theme: "forge", problems: 0 }), "output"), "console");
    assert.equal(resolveTab(dockTabs({ theme: "forge", problems: 0 }), "bakes"), "console");
  });

  it("keeps Problems, which the reference does not have and we do", () => {
    for (const theme of ["m3", "forge"] as const) assert.ok(ids(theme).includes("problems"), theme);
  });

  it("draws no Code tab: the handoff lives where the locations are (EU9)", () => {
    assert.ok(!ids("forge").includes("code"));
  });

  it("counts problems on the label in both, and says nothing when there are none", () => {
    for (const theme of ["m3", "forge"] as const) {
      const tab = (n: number) => dockTabs({ theme, problems: n }).find((t) => t.id === "problems")?.label;
      assert.equal(tab(0), "Problems");
      assert.equal(tab(3), "Problems · 3");
    }
  });
});

describe("a layout saved under the other theme", () => {
  it("keeps the tab when it exists here", () => {
    assert.equal(resolveTab(dockTabs({ theme: "forge", problems: 0 }), "problems"), "problems");
    assert.equal(resolveTab(dockTabs({ theme: "m3", problems: 0 }), "bakes"), "bakes");
  });

  it("reads the console back as the Output tab it grew out of", () => {
    assert.equal(resolveTab(dockTabs({ theme: "m3", problems: 0 }), "console"), "output");
  });

  it("sends the forge-only tabs somewhere real in Material 3", () => {
    for (const id of ["changes", "integrations"]) {
      assert.equal(resolveTab(dockTabs({ theme: "m3", problems: 0 }), id), "output", id);
    }
  });

  it("falls back to the first tab for an id from neither theme", () => {
    assert.equal(resolveTab(dockTabs({ theme: "forge", problems: 0 }), "nonsense"), "console");
  });

  it("never answers with a tab the dock is not showing", () => {
    for (const theme of ["m3", "forge"] as const) {
      const tabs = dockTabs({ theme, problems: 0 });
      for (const id of ["output", "bakes", "console", "changes", "integrations", "problems", "nonsense"]) {
        assert.ok(tabs.some((t) => t.id === resolveTab(tabs, id)), `${theme}: ${id}`);
      }
    }
  });
});
