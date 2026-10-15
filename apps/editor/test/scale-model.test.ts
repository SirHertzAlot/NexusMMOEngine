/** Scale editor rules: pure edits of the ScaleDoc and the gauge that sizes the catalog against a 1.8 m character. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCALE, validateScale, type ScaleDoc } from "@mmo-engine/scene";
import { CHARACTER_HEIGHT, categorize, gaugeLayout, parseFactor, removeAsset, renameAsset, scaleGauge, setAsset, setCategory, setGlobal, type GaugeModel } from "../src/scale-model.js";

describe("scale edits", () => {
  it("setGlobal / setCategory / setAsset return new docs and leave the input alone", () => {
    const d: ScaleDoc = { ...DEFAULT_SCALE, categories: { building: 0.6 } };
    assert.equal(setGlobal(d, 2).global, 2);
    assert.deepEqual(setCategory(d, "tree", 1.5).categories, { building: 0.6, tree: 1.5 });
    assert.deepEqual(setAsset(d, "a/b*", 3).assets, { "a/b*": 3 });
    assert.deepEqual(d, { ...DEFAULT_SCALE, categories: { building: 0.6 } });
  });
  it("a category set to undefined is removed (counts as 1 again)", () => {
    assert.deepEqual(setCategory({ ...DEFAULT_SCALE, categories: { rock: 2 } }, "rock", undefined).categories, {});
  });
  it("removeAsset drops a row; renameAsset keeps its factor and place, and refuses a taken or empty id", () => {
    const d = { ...DEFAULT_SCALE, assets: { a: 1, b: 2, c: 3 } };
    assert.deepEqual(removeAsset(d, "b").assets, { a: 1, c: 3 });
    assert.deepEqual(Object.entries(renameAsset(d, "b", "z").assets), [["a", 1], ["z", 2], ["c", 3]]);
    assert.equal(renameAsset(d, "b", "a"), d);
    assert.equal(renameAsset(d, "b", " "), d);
  });
  it("parseFactor reads a number, nothing else", () => {
    assert.equal(parseFactor(" 1.5 "), 1.5);
    assert.equal(parseFactor(""), null);
    assert.equal(parseFactor("abc"), null);
  });
  it("an edit that leaves the range is still a doc, and validateScale says why", () => {
    assert.equal(validateScale(setGlobal(DEFAULT_SCALE, 99))[0].path, "global");
  });
});

describe("categorize", () => {
  it("maps catalog models to a scale category, or null for what has none", () => {
    assert.equal(categorize({ id: "p/House_01", category: "House", name: "House_01", size: [1, 1, 1] }), "building");
    assert.equal(categorize({ id: "p/x", category: "Environments", name: "Oak_Tree_2", size: [1, 1, 1] }), "tree");
    assert.equal(categorize({ id: "p/x", category: "Rocks", name: "Big_01", size: [1, 1, 1] }), "rock");
    assert.equal(categorize({ id: "p/x", category: "Props", name: "Fern_1", size: [1, 1, 1] }), "plant");
    assert.equal(categorize({ id: "p/x", category: "Weapons", name: "Sword", size: [1, 1, 1] }), null);
  });
});

const m = (id: string, category: string, name: string, h: number): GaugeModel => ({ id, category, name, size: [1, h, 1] });

describe("scaleGauge", () => {
  const models = [m("p/a", "House", "a", 10), m("p/b", "House", "b", 20), m("p/c", "Rocks", "c", 2), m("p/d", "Props", "Tree_1", 12)];
  it("lists every category, with the median height after the factors and a character beside it", () => {
    const g = scaleGauge(models, DEFAULT_SCALE);
    assert.equal(g.character, CHARACTER_HEIGHT);
    assert.deepEqual(g.rows.map((r) => r.category), ["building", "tree", "rock", "plant"]);
    const b = g.rows[0];
    assert.equal(b.count, 2);
    assert.equal(b.typical, 15);
    assert.equal(b.status, "high"); // building band 3-14
    assert.equal(g.rows[1].status, "ok"); // tree 12 in 4-30
    assert.equal(g.rows[2].status, "ok"); // rock 2 in 0.3-8
    assert.equal(g.rows[3].status, "none"); // no plants
  });
  it("applies global x category x asset to each model before judging", () => {
    const g = scaleGauge(models, { ...DEFAULT_SCALE, global: 0.5, categories: { building: 0.8 }, assets: { "p/a": 2 } });
    // a: 10*.5*.8*2 = 8, b: 20*.5*.8 = 8
    assert.equal(g.rows[0].typical, 8);
    assert.equal(g.rows[0].status, "ok");
    assert.equal(g.rows[0].factor, 0.4);
    assert.equal(g.rows[1].typical, 6); // tree 12*.5
  });
  it("flags too small as low, and reports min and max", () => {
    const g = scaleGauge(models, { ...DEFAULT_SCALE, categories: { rock: 0.1 } });
    assert.equal(g.rows[2].status, "low");
    assert.equal(g.rows[0].min, 10);
    assert.equal(g.rows[0].max, 20);
  });
  it("an empty catalog gives rows with status none", () => {
    assert.ok(scaleGauge([], DEFAULT_SCALE).rows.every((r) => r.status === "none" && r.count === 0));
  });
});

describe("gaugeLayout", () => {
  it("places a character and a box of the typical height per judged category, left to right, and frames them all", () => {
    const g = scaleGauge([m("p/a", "House", "a", 10), m("p/c", "Rocks", "c", 2)], DEFAULT_SCALE);
    const l = gaugeLayout(g);
    assert.deepEqual(l.items.map((i) => i.category), ["building", "rock"], "empty categories are left out");
    assert.equal(l.items[0].height, 10);
    assert.ok(l.items[1].characterX > l.items[0].boxX + l.items[0].width / 2, "no overlap");
    assert.ok(l.top >= 10 && l.right > l.items[1].boxX, "frame covers everything");
  });
  it("an empty gauge still frames the character", () => {
    const l = gaugeLayout(scaleGauge([], DEFAULT_SCALE));
    assert.equal(l.items.length, 0);
    assert.ok(l.top >= CHARACTER_HEIGHT);
  });
});
