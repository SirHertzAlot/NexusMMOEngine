/**
 * WL1 (moving creatures): every wildlife species has a stand-in model until its art arrives. Titles come from the
 * table; a catalog of those titles binds every species through speciesModels, so the creature system shows a look.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadWildlifeTable, placeholderTitles, speciesModels, type CatalogModel } from "../../src/procgen/wildlife-table.js";

describe("wildlife placeholders", () => {
  const t = loadWildlifeTable();
  const titles = placeholderTitles(t);

  it("gives every species one lowercase title from its first model name", () => {
    assert.equal(titles.length, Object.keys(t.species).length);
    for (const x of titles) assert.match(x.title, /^[a-z][a-z_]*$/, x.publicID);
    assert.equal(titles.find((x) => x.publicID === "deer")?.title, "deer");
  });

  it("binds every species to a stand-in model built from its title", () => {
    const catalog: CatalogModel[] = titles.map((x) => ({ id: `placeholder/${x.publicID}`, name: x.title, skinned: false }));
    const bound = speciesModels(t, catalog);
    const missing = Object.keys(t.species).filter((id) => !bound[id]?.length);
    assert.deepEqual(missing, [], "no species left without a look");
    assert.deepEqual(bound.deer, ["placeholder/deer"]);
  });
});
