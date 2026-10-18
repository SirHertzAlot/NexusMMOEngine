/** The committed credits file has the shape the entrance screen reads, and a wrong one is refused. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCredits } from "../src/credits.js";
import { naturalSizeM } from "../src/convert/natural-size.js";
import { entryFile, fitGlb, glbStats, importSlug } from "../src/convert/import-glb-packs.js";
import { writeGlb } from "../src/convert/glb-textures.js";

const credits = JSON.parse(readFileSync(new URL("../../../../content/credits.json", import.meta.url), "utf8")) as unknown;

describe("credits.json", () => {
  it("parses, with an author, licence and text per entry", () => {
    const c = parseCredits(credits);
    assert.ok(c.thirdPartyArt.length > 0);
    for (const e of c.thirdPartyArt) assert.ok(e.author && e.licence && e.text);
  });
  it("refuses unknown keys and a wrong version", () => {
    assert.throws(() => parseCredits({ version: 2, thirdPartyArt: [] }));
    assert.throws(() => parseCredits({ version: 1, thirdPartyArt: [{ author: "a", source: "https://x.test", licence: "l", text: "t", confirmed: true, model: "m" }] }));
  });
});

describe("glb pack import (synthetic)", () => {
  // A 100 x 40 x 20 unit box centred on the origin, as a one-node GLB.
  const glb = writeGlb({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ count: 8, min: [-50, -20, -10], max: [50, 20, 10] }],
  } as never, null);

  it("measures bounds, and fits to a natural size with the base on the ground", () => {
    const st = glbStats(glb);
    assert.deepEqual(st.size, [100, 40, 20]);
    assert.equal(st.skinned, false);
    const fit = fitGlb(glb, st, 1);
    assert.deepEqual(fit.size, [1, 0.4, 0.2]);
    const after = glbStats(fit.glb);
    assert.deepEqual(after.size, [1, 0.4, 0.2]);
    assert.ok(Math.abs(after.min[1]) < 1e-9, "base at y = 0");
  });
  it("names packs and finds files with and without `file`", () => {
    assert.equal(importSlug("poly-pizza-farm-animals"), "farm-animals");
    const glbs = ["Sheep_abc-1.glb", "Sheep_xyz.glb"];
    assert.equal(entryFile({ title: "Sheep", publicID: "abc-1" }, glbs), "Sheep_abc-1.glb");
    assert.equal(entryFile({ title: "Sheep", publicID: "none" }, glbs), undefined);
  });
  it("sizes by whole words: a beet is not a bee", () => {
    assert.equal(naturalSizeM("farm-produce", "Beet"), 0.12);
    assert.equal(naturalSizeM("forest-creatures", "Bee"), 0.05);
    assert.equal(naturalSizeM("forest-creatures", "Pheasant_ring-necked"), 0.7);
    assert.equal(naturalSizeM("unknown-pack", "Zzz"), undefined);
  });
});
