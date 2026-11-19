/** The baked mask asset round-trips, and the bake writes it when asked. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeTerrainMaskAsset, encodeTerrainMaskAsset } from "@mmo-engine/art/browser";
import { bakeWorldTerrain } from "../src/terrain/world-bake.js";
import { parseWorldSpec } from "../src/terrain/world-spec.js";

describe("terrain mask asset", () => {
  it("round-trips the header and the RGBA bytes", () => {
    const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 7) & 255);
    const bytes = encodeTerrainMaskAsset({ width: 3, depth: 2, cell: 0.5, originX: -16, originZ: 32, rgba });
    const back = decodeTerrainMaskAsset(bytes);
    assert.equal(back.width, 3);
    assert.equal(back.depth, 2);
    assert.equal(back.cell, 0.5);
    assert.equal(back.originX, -16);
    assert.equal(back.originZ, 32);
    assert.deepEqual(Array.from(back.rgba), Array.from(rgba));
  });

  it("rejects a bad magic, a bad size and a truncated file", () => {
    const good = encodeTerrainMaskAsset({ width: 2, depth: 2, cell: 1, originX: 0, originZ: 0, rgba: new Uint8Array(16) });
    const badMagic = good.slice();
    badMagic[0] = 0x58;
    assert.throws(() => decodeTerrainMaskAsset(badMagic), /magic/);
    assert.throws(() => encodeTerrainMaskAsset({ width: 2, depth: 2, cell: 1, originX: 0, originZ: 0, rgba: new Uint8Array(3) }), /rgba/);
    assert.throws(() => decodeTerrainMaskAsset(good.slice(0, good.length - 4)), /truncated/);
  });

  it("the world bake writes the asset to maskAssetPath", async () => {
    const spec = parseWorldSpec(JSON.parse(fs.readFileSync(new URL("../../worlds/tiny-test.world.json", import.meta.url), "utf8")));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-mask-asset-"));
    const assetPath = path.join(dir, "terrain-mask.bin");
    await bakeWorldTerrain(spec, { dbPath: path.join(dir, "region.db"), catalogDir: null, log: () => {}, terrainVersion: 1, workers: 1, maskAssetPath: assetPath });
    const asset = decodeTerrainMaskAsset(new Uint8Array(fs.readFileSync(assetPath)));
    assert.equal(asset.width, spec.sizeChunks * 16);
    assert.equal(asset.rgba.length, asset.width * asset.width * 4);
  });
});
