/** Strings panel edit rules: pure operations on the tables. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addId, addLang, changedLangs, coverage, removeId, setMessage } from "../src/strings-model.js";

const T = { en: { a: "A", b: "B" }, de: { a: "Ah" } };

describe("strings model", () => {
  it("setMessage sets, and for a translation empty text removes (missing)", () => {
    assert.deepEqual(setMessage(T, "de", "b", "Be").de, { a: "Ah", b: "Be" });
    assert.deepEqual(setMessage(T, "de", "a", "").de, {});
    assert.equal(setMessage(T, "en", "a", "").en.a, "");
    assert.deepEqual(T.de, { a: "Ah" }, "input untouched");
  });
  it("addId adds to English only, once", () => {
    assert.deepEqual(addId(T, "c", "C").en, { a: "A", b: "B", c: "C" });
    assert.deepEqual(addId(T, "c", "C").de, { a: "Ah" });
    assert.equal(addId(T, "a", "other"), T);
    assert.equal(addId(T, "", "x"), T);
  });
  it("removeId removes from every language", () => {
    assert.deepEqual(removeId(T, "a"), { en: { b: "B" }, de: {} });
  });
  it("addLang adds an empty table, once", () => {
    assert.deepEqual(addLang(T, "fr").fr, {});
    assert.equal(addLang(T, "de"), T);
  });
  it("changedLangs is what a save sends", () => {
    assert.deepEqual(changedLangs(T, T), {});
    assert.deepEqual(changedLangs(setMessage(T, "de", "b", "Be"), T), { de: { a: "Ah", b: "Be" } });
    assert.deepEqual(changedLangs(addLang(T, "fr"), T), { fr: {} });
  });
  it("coverage is the share of English ids a language has", () => {
    assert.equal(coverage(T, "en"), 1);
    assert.equal(coverage(T, "de"), 0.5);
    assert.equal(coverage(T, "fr"), 0);
  });
});
