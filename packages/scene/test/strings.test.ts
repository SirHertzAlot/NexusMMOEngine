/** EA25: ICU subset, pseudo-locale, language choice, validation and the panel's rows. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadStrings, messageIssues, pickLang, pseudoLocalize, stringRows, t, translator, validateTables } from "../src/strings.js";

const EN = {
  "app.title": "Nexus",
  "hi": "Hello, {name}!",
  "bag.slots": "{count, plural, one {# slot} other {# slots}}",
  "party.n": "{n, plural, =0 {nobody} one {# member, {who}} other {# members}}",
  "pick": "{kind, select, sword {a blade} other {a thing}}",
};

describe("loadStrings", () => {
  it("accepts a table and rejects non-strings and empty ids", () => {
    assert.equal(loadStrings(EN)["app.title"], "Nexus");
    assert.throws(() => loadStrings({ "a.b": 42 }), /string/);
    assert.throws(() => loadStrings({ "": "x" }), /id/);
    assert.throws(() => loadStrings([]), /object/);
  });
});

describe("t", () => {
  it("formats placeholders, plurals, exact matches and select", () => {
    assert.equal(t(EN, "hi", { name: "Joey" }), "Hello, Joey!");
    assert.equal(t(EN, "bag.slots", { count: 1 }), "1 slot");
    assert.equal(t(EN, "bag.slots", { count: 5 }), "5 slots");
    assert.equal(t(EN, "party.n", { n: 0 }), "nobody");
    assert.equal(t(EN, "party.n", { n: 1, who: "Ann" }), "1 member, Ann");
    assert.equal(t(EN, "pick", { kind: "sword" }), "a blade");
    assert.equal(t(EN, "pick", { kind: "axe" }), "a thing");
  });
  it("falls back to the id, leaves unknown placeholders, returns malformed text raw", () => {
    assert.equal(t(EN, "nope"), "nope");
    assert.equal(t(EN, "hi"), "Hello, {name}!");
    assert.equal(t({ a: "oops {x" }, "a"), "oops {x");
  });
});

describe("pseudoLocalize", () => {
  it("stretches and accents, keeps placeholders and plural syntax so it still formats", () => {
    const p = pseudoLocalize("Welcome, {name}!");
    assert.ok(p.length > "Welcome, {name}!".length && p.includes("{name}") && p.startsWith("⟦") && p.endsWith("⟧"));
    const plural = pseudoLocalize(EN["bag.slots"]);
    assert.match(plural, /\{count, plural, one \{# /);
    assert.deepEqual(messageIssues(EN["bag.slots"], plural), []);
    assert.match(t({ x: plural }, "x", { count: 2 }), /^⟦2 /);
  });
});

describe("translator", () => {
  const tables = { en: EN, de: { hi: "Hallo, {name}!" } };
  it("uses the language, then English, then the id", () => {
    assert.equal(translator(tables, "de")("hi", { name: "A" }), "Hallo, A!");
    assert.equal(translator(tables, "de")("app.title"), "Nexus");
    assert.equal(translator(tables, "de")("zzz"), "zzz");
  });
  it("pseudo is derived from English", () => {
    assert.match(translator(tables, "pseudo")("hi", { name: "A" }), /^⟦.*A.*⟧$/);
    assert.notEqual(translator(tables, "pseudo")("app.title"), "Nexus");
  });
});

describe("pickLang", () => {
  it("?lang= beats stored beats browser; unknown falls to English", () => {
    const a = ["en", "de"];
    assert.equal(pickLang(a, "?lang=pseudo", "de", ["en"]), "pseudo");
    assert.equal(pickLang(a, "", "de", ["en"]), "de");
    assert.equal(pickLang(a, "", null, ["de-AT"]), "de");
    assert.equal(pickLang(a, "?lang=xx", null, ["fr"]), "en");
  });
});

describe("validation", () => {
  it("names broken ICU and placeholder mismatches", () => {
    assert.deepEqual(messageIssues("Hi {name}", "Hallo {name}"), []);
    assert.deepEqual(messageIssues("Hi {name}", "Hallo"), ["missing placeholder {name}"]);
    assert.deepEqual(messageIssues("Hi", "Hallo {x}"), ["unknown placeholder {x}"]);
    assert.match(messageIssues("a", "{n, plural, one {x}}")[0], /other/);
    assert.match(messageIssues("a", "oops }")[0], /unmatched/);
    assert.deepEqual(messageIssues("a", "  "), ["empty"]);
  });
  it("validateTables reports ids, extras and per-language problems", () => {
    const issues = validateTables({ en: { "ok.id": "Hi {a}", "bad id": "x" }, de: { "ok.id": "Hallo", "only.de": "x" } });
    assert.deepEqual(issues.map((i) => `${i.lang}:${i.id}:${i.message}`), [
      "en:bad id:not a string id (letters, digits, _ and -, joined by dots)",
      "de:ok.id:missing placeholder {a}",
      "de:only.de:not in the English source",
    ]);
  });
});

describe("stringRows", () => {
  it("lists English ids then extras, with a status per language", () => {
    const rows = stringRows({ en: { a: "A {x}", b: "B" }, de: { a: "A", c: "C" } }, ["en", "de"]);
    assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c"]);
    assert.equal(rows[0].cells.de.status, "invalid");
    assert.equal(rows[1].cells.de.status, "missing");
    assert.equal(rows[2].cells.de.status, "extra");
    assert.equal(rows[2].cells.en.status, "missing");
  });
});
