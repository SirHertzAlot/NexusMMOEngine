import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  formatMessage,
  messageArgs,
  parseMessage,
  stringsStatus,
  textHash,
  validateStrings,
  type StringsBundle,
} from "../src/index.js";

const dir = new URL("../../../../content/strings/", import.meta.url);
const load = (lang: string): StringsBundle => JSON.parse(readFileSync(new URL(`${lang}.json`, dir), "utf8")) as StringsBundle;

describe("ICU messages", () => {
  it("formats arguments, numbers and the pound sign", () => {
    assert.equal(formatMessage("Hello {name}!", { name: "Ada" }), "Hello Ada!");
    assert.equal(formatMessage("{n, number} gold", { n: 12345 }, { lang: "en" }), "12,345 gold");
    assert.equal(formatMessage("{n, plural, =0 {none} one {# item} other {# items}}", { n: 1 }), "1 item");
    assert.equal(formatMessage("{n, plural, =0 {none} one {# item} other {# items}}", { n: 0 }), "none");
    assert.equal(formatMessage("{n, plural, =0 {none} one {# item} other {# items}}", { n: 1234 }), "1,234 items");
    assert.equal(formatMessage("{g, select, f {she} m {he} other {they}} left", { g: "m" }), "he left");
    assert.equal(formatMessage("{g, select, f {she} other {they}} left", { g: "x" }), "they left");
  });
  it("nests, and uses the language's plural rules", () => {
    const m = "{n, plural, one {{who} has # coin} other {{who} has # coins}}";
    assert.equal(formatMessage(m, { n: 1, who: "Bo" }), "Bo has 1 coin");
    assert.equal(formatMessage(m, { n: 3, who: "Bo" }), "Bo has 3 coins");
    // Polish has a "few" form: without it the "other" case answers.
    assert.equal(formatMessage("{n, plural, few {a} other {b}}", { n: 3 }, { lang: "pl" }), "a");
  });
  it("quotes with apostrophes and leaves a missing argument visible", () => {
    assert.equal(formatMessage("It''s '{literal}' {x}", {}), "It's {literal} {x}");
    assert.equal(formatMessage("don't {a}", { a: 1 }), "don't 1");
  });
  it("lists the arguments a message uses", () => {
    assert.deepEqual([...messageArgs("{a} {n, plural, one {{b}} other {# {c}}}")].sort(), ["a", "b", "c", "n"]);
  });
  it("rejects broken syntax with a position", () => {
    for (const bad of ["{", "{a", "a}", "{n, plural, one {x}}", "{n, plural, other x}", "{a, wat, other {x}}", "{n, plural, one {x} other {y}", "{}"]) {
      assert.throws(() => parseMessage(bad), /at \d+|empty|unclosed|other/, bad);
    }
  });
  it("pseudo-locale keeps arguments, accents and brackets the text", () => {
    const out = formatMessage("Hello {name}, you have {n, plural, one {# item} other {# items}}", { name: "Ada", n: 2 }, { pseudo: true });
    assert.ok(out.startsWith("[") && out.endsWith("]"));
    assert.match(out, /Ada/);
    assert.match(out, /2/);
    assert.ok(!/Hello/.test(out), "letters are accented");
    assert.ok(out.length > "Hello Ada, you have 2 items".length * 1.2, "longer than the source");
    assert.equal(formatMessage("{x}", {}, { pseudo: true }), "[{x}~]");
  });
});

describe("string tables", () => {
  const en: StringsBundle = { version: 1, lang: "en", messages: { a: "Hello {name}", b: "Bye", c: "Open the door please now", d: "Gone" } };
  const fr: StringsBundle = {
    version: 1,
    lang: "fr",
    messages: { a: "Salut {nom}", b: "Au revoir", c: "Ouvrez la porte s'il vous plait maintenant tout de suite", z: "Extra" },
    source: { a: textHash("Hello {name}"), b: textHash("Goodbye"), c: textHash("Open the door please now") },
  };
  it("reports missing, stale, mismatched, long and extra", () => {
    const s = stringsStatus(en, fr);
    assert.equal(s.rows.find((r) => r.id === "a")?.status, "mismatch");
    assert.equal(s.rows.find((r) => r.id === "b")?.status, "stale");
    assert.equal(s.rows.find((r) => r.id === "c")?.status, "long");
    assert.equal(s.rows.find((r) => r.id === "d")?.status, "missing");
    assert.deepEqual(s.extra, ["z"]);
    assert.deepEqual(s.counts, { ok: 0, missing: 1, stale: 1, mismatch: 1, long: 1 });
  });
  it("a translation matching the current source is ok", () => {
    const ok: StringsBundle = { version: 1, lang: "de", messages: { b: "Tschuess" }, source: { b: textHash("Bye") } };
    assert.equal(stringsStatus(en, ok).rows.find((r) => r.id === "b")?.status, "ok");
  });
  it("validates ids, languages and messages", () => {
    assert.deepEqual(validateStrings(en, "en"), []);
    const bad = { version: 1, lang: "fr", messages: { "Bad Id": "x", ok: 3, broken: "{a" } };
    assert.deepEqual(validateStrings(bad, "fr").map((i) => i.path).sort(), ["messages.Bad Id", "messages.broken", "messages.ok"].sort());
    assert.equal(validateStrings(en, "fr")[0].path, "lang");
    assert.equal(validateStrings(en, "../x")[0].path, "lang");
    assert.equal(validateStrings(en, "pseudo")[0].path, "lang");
  });
});

describe("content/strings", () => {
  it("every shipped table is valid and en is the source", () => {
    const langs = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    assert.ok(langs.includes("en"));
    for (const l of langs) assert.deepEqual(validateStrings(load(l), l), [], l);
  });
});
