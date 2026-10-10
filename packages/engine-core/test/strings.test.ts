/**
 * TDD: EA25 foundation — localization string tables.
 *
 * `content/strings/<lang>.json`: ICU messages by string id. The `t()`
 * function looks them up; the pseudo-locale (accented, expanded) shakes
 * out hard-coded strings and layout overflow.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadStrings, t, pseudoLocalize, type Strings } from "../src/strings.js";

const EN: Strings = {
  "app.title": "Nexus",
  "player.welcome": "Welcome, {name}!",
  "bag.slots": "{count, plural, one {# slot} other {# slots}}",
};

describe("loadStrings", () => {
  it("loads a valid table", () => {
    const s = loadStrings(EN);
    assert.equal(s["app.title"], "Nexus");
  });

  it("rejects non-string values", () => {
    assert.throws(() => loadStrings({ "a.b": 42 }), /string/);
  });

  it("rejects empty ids", () => {
    assert.throws(() => loadStrings({ "": "x" }), /id/);
  });
});

describe("t", () => {
  it("formats a simple message", () => {
    assert.equal(t(EN, "player.welcome", { name: "Joey" }), "Welcome, Joey!");
  });

  it("handles plurals", () => {
    assert.equal(t(EN, "bag.slots", { count: 1 }), "1 slot");
    assert.equal(t(EN, "bag.slots", { count: 5 }), "5 slots");
  });

  it("falls back to the id when missing", () => {
    assert.equal(t(EN, "nope.missing"), "nope.missing");
  });

  it("leaves unknown placeholders alone", () => {
    assert.equal(t(EN, "player.welcome", {}), "Welcome, {name}!");
  });
});

describe("pseudoLocalize", () => {
  it("expands and accents the string", () => {
    const p = pseudoLocalize("Hello");
    assert.ok(p.length > "Hello".length, "pseudo-locale expands text");
    assert.ok(p !== "Hello", "pseudo-locale changes the text");
  });

  it("keeps placeholders intact", () => {
    const p = pseudoLocalize("Welcome, {name}!");
    assert.ok(p.includes("{name}"), "placeholders survive pseudo-localization");
  });
});
