/**
 * Editor console (docs/EDITOR-UI-2026.md §2.6, slice EU8).
 *
 * The console's value is that a line you saw once can be found again,
 * so the tests protect exactly that: the ring keeps the newest lines
 * and never silently reorders them, a filter hides without deleting,
 * and an empty console says WHICH kind of empty it is — nothing logged
 * yet and everything filtered out are different problems.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ALL_LEVELS,
  ALL_SOURCES,
  MAX_ENTRIES,
  clearConsole,
  countLevels,
  everything,
  filterEntries,
  getConsole,
  pushConsole,
  pushServerLines,
  stamp,
} from "../src/ui/console-log.js";
import { ForgeConsoleView, emptyReason, toggle } from "../src/ui/forge-console.js";

beforeEach(() => clearConsole());

describe("the scrollback", () => {
  it("keeps entries in the order they were recorded", () => {
    pushConsole("editor", "first");
    pushConsole("editor", "second");
    assert.deepEqual(getConsole().map((e) => e.text), ["first", "second"]);
  });

  it("drops the oldest once it is full, never the newest", () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) pushConsole("editor", `line ${i}`);
    const all = getConsole();
    assert.equal(all.length, MAX_ENTRIES);
    assert.equal(all.at(-1)?.text, `line ${MAX_ENTRIES + 4}`);
    assert.ok(!all.some((e) => e.text === "line 0"), "oldest line survived the cap");
  });

  it("gives every entry a sequence that keeps rising, so rows stay keyed apart", () => {
    const a = pushConsole("editor", "x");
    const b = pushConsole("editor", "x");
    assert.ok(b.seq > a.seq);
  });
});

describe("server lines", () => {
  it("takes each line's level from the same rule the Server tab colours by", () => {
    pushServerLines([
      "[gateway] listening on 7777",
      "WARN sidecar restart",
      "Error: failed to bind",
    ]);
    assert.deepEqual(getConsole().map((e) => e.level), ["info", "warn", "error"]);
  });

  it("drops blank padding rather than logging empty rows", () => {
    const n = pushServerLines(["one", "", "   ", "two"]);
    assert.equal(n, 2);
    assert.equal(getConsole().length, 2);
  });
});

describe("filtering hides without deleting", () => {
  const seed = (): void => {
    pushConsole("server", "gateway up", "info");
    pushConsole("server", "Error: bind failed", "error");
    pushConsole("bake", "terrain: 42 tiles", "info");
    pushConsole("editor", "Fullscreen was blocked", "warn");
  };

  it("opens showing everything", () => {
    seed();
    const f = everything();
    assert.equal(filterEntries(getConsole(), f).length, 4);
    for (const s of ALL_SOURCES) assert.ok(f.sources.has(s));
    for (const l of ALL_LEVELS) assert.ok(f.levels.has(l));
  });

  it("narrows by source", () => {
    seed();
    const f = { ...everything(), sources: new Set(["server" as const]) };
    assert.deepEqual(filterEntries(getConsole(), f).map((e) => e.text), [
      "gateway up",
      "Error: bind failed",
    ]);
    // and the entries themselves are untouched
    assert.equal(getConsole().length, 4);
  });

  it("narrows by level", () => {
    seed();
    const f = { ...everything(), levels: new Set(["error" as const, "warn" as const]) };
    assert.deepEqual(filterEntries(getConsole(), f).map((e) => e.level), ["error", "warn"]);
  });

  it("finds text without caring about case, and ignores surrounding space", () => {
    seed();
    assert.equal(filterEntries(getConsole(), { ...everything(), text: "  BIND  " }).length, 1);
    assert.equal(filterEntries(getConsole(), { ...everything(), text: "" }).length, 4);
  });

  it("counts each level for the filter chips", () => {
    seed();
    assert.deepEqual(countLevels(getConsole()), { error: 1, warn: 1, info: 2 });
  });

  it("toggles a filter member without mutating the original set", () => {
    const before = new Set(["server" as const, "bake" as const]);
    const after = toggle(before, "bake");
    assert.ok(!after.has("bake"));
    assert.ok(before.has("bake"), "the original set was mutated");
  });
});

describe("an empty console says which kind of empty", () => {
  it("distinguishes nothing-logged from everything-filtered", () => {
    assert.match(emptyReason(0, 0) ?? "", /Nothing logged yet/);
    assert.match(emptyReason(12, 0) ?? "", /filtered out/);
    assert.equal(emptyReason(12, 3), null);
  });
});

describe("the panel", () => {
  it("shows the lines and says how many of the total are visible", () => {
    pushConsole("server", "gateway up", "info");
    pushConsole("server", "Error: bind failed", "error");
    const html = renderToStaticMarkup(
      React.createElement(ForgeConsoleView, {
        entries: getConsole(),
        filter: { ...everything(), levels: new Set(["error" as const]) },
        onFilter: () => undefined,
        onClear: () => undefined,
      }),
    );
    assert.match(html, /Error: bind failed/);
    assert.doesNotMatch(html, /gateway up/);
    assert.match(html, /1 of 2 lines/);
  });

  it("stamps a wall clock, zero-padded", () => {
    const at = new Date(2026, 10, 26, 9, 3, 7).getTime();
    assert.equal(stamp(at), "09:03:07");
  });
});
