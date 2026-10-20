/**
 * Prebaked-mesh assets in the PCG library: an asset that is already a PCGM mesh
 * (a dungeon's baked shell) is listed, looked up by hash and fetched like a
 * cooked one, at revision 1, with no level-of-detail chain, and never cooked.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodePcgMesh, fnv1a32 } from "@mmo-engine/picg";
import { PcgAssetLibrary } from "../../src/pcg/asset-library.js";

const quad = encodePcgMesh({ positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });

describe("PcgAssetLibrary prebaked assets", () => {
  it("lists, finds and serves the mesh as it was baked", async () => {
    const library = PcgAssetLibrary.empty();
    const info = library.addPrebaked("dungeon:test", quad, "The Test Barrow");
    assert.equal(info.assetHash, fnv1a32("dungeon:test"));
    assert.deepEqual(library.list().map((a) => a.id), ["dungeon:test"]);
    assert.equal(library.info(info.assetHash)?.displayName, "The Test Barrow");
    const mesh = await library.mesh(info.assetHash, 0);
    assert.ok(mesh);
    assert.deepEqual(mesh.bytes, quad, "served untouched");
    assert.equal(mesh.vertexCount, 4);
    assert.equal(mesh.triangleCount, 2);
    assert.deepEqual(mesh.lods, [], "a shell has no coarser levels");
    assert.equal(await library.cachedMesh(info.assetHash, 0, 1), mesh, "the GET-by-URL lookup finds it");
    assert.equal(library.cachedMesh(info.assetHash, 0, 2), null, "only its own revision");
  });

  it("refuses bytes that aren't PCGM and ids that collide", () => {
    const library = PcgAssetLibrary.empty();
    assert.throws(() => library.addPrebaked("dungeon:bad", new Uint8Array(32)), /PCGM/);
    library.addPrebaked("dungeon:a", quad);
    assert.throws(() => library.addPrebaked("dungeon:a", quad), /collision/);
  });
});
