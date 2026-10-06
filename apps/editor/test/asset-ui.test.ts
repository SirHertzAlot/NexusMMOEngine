/**
 * Art & audio library dock ↔ asset panel contract: one shared store
 * carries the model filter and the preview selection, so the dock
 * search filters the panel table and dock picks preview in the panel.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assetUiStore,
  setAssetFilter,
  setAssetPreview,
} from "../src/ui/asset-inspector.js";

describe("assetUiStore", () => {
  it("starts unfiltered with no preview", () => {
    assetUiStore.set({ filter: "", previewId: null });
    assert.deepEqual(assetUiStore.get(), { filter: "", previewId: null });
  });

  it("filter and preview setters preserve each other", () => {
    assetUiStore.set({ filter: "", previewId: null });
    setAssetFilter("ghost");
    assert.equal(assetUiStore.get().filter, "ghost");
    assert.equal(assetUiStore.get().previewId, null);
    setAssetPreview("dungeon-pack/Character_Ghost_01");
    assert.equal(assetUiStore.get().filter, "ghost");
    assert.equal(assetUiStore.get().previewId, "dungeon-pack/Character_Ghost_01");
    setAssetPreview(null);
    assert.equal(assetUiStore.get().previewId, null);
  });
});
