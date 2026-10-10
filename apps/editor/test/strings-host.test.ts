/** Strings host: content/strings/<lang>.json, validated saves, refused saves write nothing. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStringsRoute } from "../src/strings-host.js";

const EN = { "app.title": "Nexus", "hi": "Hello, {name}!", "bag.slots": "{count, plural, one {# slot} other {# slots}}" };
function fakeRepo(): string {
  const root = join(tmpdir(), `mmo-strings-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  mkdirSync(join(root, "content", "strings"), { recursive: true });
  writeFileSync(join(root, "content", "strings", "en.json"), JSON.stringify(EN));
  writeFileSync(join(root, "content", "strings", "de.json"), JSON.stringify({ hi: "Hallo, {name}!" }));
  return root;
}
const put = (root: string, tables: unknown) => handleStringsRoute(root, "PUT", "/api/editor/strings", JSON.stringify({ tables }));
const files = (root: string): string[] => readdirSync(join(root, "content", "strings")).sort();
const read = (root: string, lang: string): unknown => JSON.parse(readFileSync(join(root, "content", "strings", `${lang}.json`), "utf8"));

describe("strings routes", () => {
  it("ignores other paths and unknown subpaths", () => {
    assert.equal(handleStringsRoute("x", "GET", "/api/editor/flow", undefined), null);
    assert.equal(handleStringsRoute("x", "GET", "/api/editor/strings/en", undefined)?.status, 404);
  });
  it("GET lists the languages (English first) and their tables", () => {
    const root = fakeRepo();
    const r = handleStringsRoute(root, "GET", "/api/editor/strings", undefined);
    const b = r?.body as { langs: string[]; tables: Record<string, Record<string, string>> };
    assert.equal(r?.status, 200);
    assert.deepEqual(b.langs, ["en", "de"]);
    assert.deepEqual(b.tables.en, EN);
    assert.equal(b.tables.de.hi, "Hallo, {name}!");
    rmSync(root, { recursive: true });
  });
  it("saves only the languages sent, and creates a new language", () => {
    const root = fakeRepo();
    const r = put(root, { de: { hi: "Hallo, {name}!", "app.title": "Nexus" }, fr: {} });
    assert.equal(r?.status, 200);
    assert.deepEqual((r?.body as { saved: string[] }).saved, ["de", "fr"]);
    assert.deepEqual(files(root), ["de.json", "en.json", "fr.json"]);
    assert.deepEqual(read(root, "de"), { hi: "Hallo, {name}!", "app.title": "Nexus" });
    assert.deepEqual(read(root, "en"), EN);
    rmSync(root, { recursive: true });
  });
  it("a refused save (placeholder drift, bad ICU, id English lacks) answers 400 with issues and writes nothing", () => {
    const root = fakeRepo();
    const before = readFileSync(join(root, "content", "strings", "de.json"), "utf8");
    const r = put(root, { de: { hi: "Hallo!", "bag.slots": "{count, plural, one {# x}}", "only.de": "x" } });
    assert.equal(r?.status, 400);
    const issues = (r?.body as { issues: { lang: string; id: string; message: string }[] }).issues;
    assert.deepEqual(issues.map((i) => `${i.id}: ${i.message}`).sort(), [
      "bag.slots: not valid ICU: plural needs an \"other\" option at 26",
      "hi: missing placeholder {name}",
      "only.de: not in the English source",
    ]);
    assert.equal(readFileSync(join(root, "content", "strings", "de.json"), "utf8"), before);
    assert.deepEqual(files(root), ["de.json", "en.json"]);
    rmSync(root, { recursive: true });
  });
  it("an English change that breaks a translation is refused too", () => {
    const root = fakeRepo();
    const r = put(root, { en: { ...EN, hi: "Hello!" } });
    assert.equal(r?.status, 400);
    assert.match(JSON.stringify(r?.body), /unknown placeholder \{name\}/);
    rmSync(root, { recursive: true });
  });
  it("only language codes name a file: no paths, no pseudo-locale", () => {
    const root = fakeRepo();
    for (const lang of ["../x", "pseudo", "EN", "de.json"]) assert.equal(put(root, { [lang]: {} })?.status, 400, lang);
    assert.deepEqual(files(root), ["de.json", "en.json"]);
    rmSync(root, { recursive: true });
  });
  it("rejects a body that is not JSON or has no tables, and non-string messages", () => {
    const root = fakeRepo();
    assert.equal(handleStringsRoute(root, "PUT", "/api/editor/strings", "nope")?.status, 400);
    assert.equal(handleStringsRoute(root, "PUT", "/api/editor/strings", "{}")?.status, 400);
    assert.equal(put(root, { de: { hi: 3 } })?.status, 400);
    rmSync(root, { recursive: true });
  });
});
