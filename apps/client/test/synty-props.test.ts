/**
 * Art-pack props' materials: the shared atlas replaces the file's blank
 * stand-in, an embedded texture is kept, vertex colours (stripped by the
 * merge) are turned off so models don't draw black, and materials are
 * shared per atlas, not by name alone.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { prepareMaterial, sharedMaterialKey } from "../src/render/synty-props.js";

describe("art-pack prop materials", () => {
  it("take the shared atlas, textured white, without vertex colours", () => {
    const atlas = new THREE.Texture();
    const blank = new THREE.Texture();
    const m = new THREE.MeshStandardMaterial({ map: blank, vertexColors: true, color: 0x777777 });
    const asked: string[] = [];
    prepareMaterial(m, "http://x/textures/pack/Atlas.png", (url) => (asked.push(url), atlas));
    assert.equal(m.map, atlas);
    assert.deepEqual(asked, ["http://x/textures/pack/Atlas.png"]);
    assert.equal(m.vertexColors, false, "the merge strips colours: a material asking for them draws black");
    assert.equal(m.color.getHex(), 0xffffff);
    assert.equal(m.roughness, 0.9);
  });

  it("keep a texture embedded in the file when there's no external atlas", () => {
    const embedded = new THREE.Texture();
    const m = new THREE.MeshStandardMaterial({ map: embedded, vertexColors: true });
    prepareMaterial(m, null, () => assert.fail("no atlas to load"));
    assert.equal(m.map, embedded);
    assert.equal(m.vertexColors, false);
  });

  it("share by atlas and name; embedded ones stay per model", () => {
    assert.notEqual(sharedMaterialKey("Mat_01", "http://x/a.png", "pack-a/Tree"), sharedMaterialKey("Mat_01", "http://x/b.png", "pack-b/Rock"), "same name, different atlas");
    assert.equal(sharedMaterialKey("Mat_01", "http://x/a.png", "pack-a/Tree"), sharedMaterialKey("Mat_01", "http://x/a.png", "pack-a/Bush"), "one pack's models share");
    assert.notEqual(sharedMaterialKey("Mat_01", null, "pack-a/Tree"), sharedMaterialKey("Mat_01", null, "pack-a/Bush"));
  });
});
