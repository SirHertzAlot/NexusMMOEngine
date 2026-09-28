/**
 * Pack converter building blocks, on synthetic data only (the real packs
 * are licensed and never used in tests): material-list parsing, pack
 * naming, the GLB atlas rewrite, and manifest-first scanning.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import {
  indexMeshes,
  parseMaterialList,
  parseSlot,
  primaryTexture,
} from "../src/convert/material-list.js";
import { readGlbJson, withExternalTextures } from "../src/convert/glb-textures.js";
import { packSlug } from "../src/convert/convert-packs.js";
import { scanAssetDir } from "../src/scan.js";

const LIST = `-------------------
Folder Name: Props
-------------------
Prefab Name: SM_Prop_Barrel_01
    Mesh Name: SM_Prop_Barrel_01
        Slot: Kingdom_Mat_01_A (Kingdom_Texture_01_A)

Prefab Name: SM_Prop_Lamp_01
    Mesh Name: SM_Prop_Lamp_01
        Slot: Kingdom_Mat_01_A (Kingdom_Texture_01_A)
        Slot: Kingdom_Mat_Glass (Kingdom_Texture_01_A)
-------------------
Folder Name: Characters
-------------------
Prefab Name: Character_BR_BigOrk_01
    Mesh Name: Character_Big_Ork_01
        Slot: Rivals_01_A (Rivals_Texture_01_A)
    Mesh Name: Character_Dwarf_01
        Slot: Rivals_01_A (Rivals_Texture_01_A)
Prefab Name: Chr_Head_Male_00
    Mesh Name: Chr_Head_Male_00
        Slot: FantasyHero (Uses custom shader)
`;

describe("material list", () => {
  it("takes the texture from the LAST parenthesised name", () => {
    assert.deepEqual(parseSlot("Mat_Ground (1) (PFK_Texture_Ground_Grass_01)"), {
      material: "Mat_Ground (1)", texture: "PFK_Texture_Ground_Grass_01", customShader: false,
    });
    assert.deepEqual(parseSlot("FantasyHero (Uses custom shader)"), {
      material: "FantasyHero", texture: null, customShader: true,
    });
    assert.equal(parseSlot("FX_CandleFlame (No Albedo Texture)").texture, null);
  });

  it("parses folders, prefabs, meshes, and ordered slots", () => {
    const list = parseMaterialList(LIST.replace(/\n/g, "\r\n")); // Windows line endings
    const lamp = list.get("SM_Prop_Lamp_01")!;
    assert.equal(lamp.folder, "Props");
    assert.deepEqual(lamp.meshes.get("SM_Prop_Lamp_01")!.map((s) => s.material), ["Kingdom_Mat_01_A", "Kingdom_Mat_Glass"]);
    assert.equal(list.get("Character_BR_BigOrk_01")!.folder, "Characters");
    assert.equal(primaryTexture(list), "Kingdom_Texture_01_A");
  });

  it("indexes meshes so files named differently from prefabs still match", () => {
    const index = indexMeshes(parseMaterialList(LIST));
    const ork = index.get("Character_Big_Ork_01")!;
    assert.equal(ork.prefab, "Character_BR_BigOrk_01");
    assert.equal(ork.folder, "Characters");
    assert.equal(ork.slots[0].texture, "Rivals_Texture_01_A");
  });
});

describe("packSlug", () => {
  it("turns pack folders into short stable ids", () => {
    assert.equal(packSlug("POLYGON_FantasyKingdom_SourceFiles_v3"), "fantasy-kingdom");
    assert.equal(packSlug("POLYGON_Fantasy_Rivals_SourceFiles_v3"), "fantasy-rivals");
    assert.equal(packSlug("POLYGON_Modular_Fantasy_Hero_SourceFiles_v2"), "modular-fantasy-hero");
    assert.equal(packSlug("POLYGON_Dungeon_Pack_SourceFiles_v2"), "dungeon-pack");
  });
});

/** GLTFExporter's binary path needs FileReader, which Node lacks. */
function ensureFileReader(): void {
  const g = globalThis as { FileReader?: unknown };
  g.FileReader ??= class {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob): void {
      void blob.arrayBuffer().then((r) => {
        this.result = r;
        this.onloadend?.();
      });
    }
  };
}

async function sampleGlb(): Promise<Uint8Array> {
  ensureFileReader();
  const scene = new THREE.Group();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  for (const name of ["Atlas_A", "Atlas_A_Glass", "Untextured"]) {
    scene.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ name, color: 0x336699 })));
  }
  return new Uint8Array((await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer);
}

describe("withExternalTextures", () => {
  it("points named materials at a shared external atlas; binary untouched", async () => {
    const glb = await sampleGlb();
    const before = readGlbJson(glb);
    const out = withExternalTextures(glb, new Map([
      ["Atlas_A", "../../textures/pack/Atlas_A.png"],
      ["Atlas_A_Glass", "../../textures/pack/Atlas_A.png"],
    ]));
    const { json, bin } = readGlbJson(out);
    assert.deepEqual(json.images, [{ uri: "../../textures/pack/Atlas_A.png" }], "one shared image");
    assert.equal(json.textures?.length, 1);
    const byName = new Map((json.materials ?? []).map((m) => [m.name, m]));
    for (const name of ["Atlas_A", "Atlas_A_Glass"]) {
      const pbr = byName.get(name)!.pbrMetallicRoughness as { baseColorTexture?: { index: number }; baseColorFactor?: number[] };
      assert.deepEqual(pbr.baseColorTexture, { index: 0 });
      assert.deepEqual(pbr.baseColorFactor, [1, 1, 1, 1], "white so the atlas shows unmodified");
    }
    assert.equal((byName.get("Untextured")!.pbrMetallicRoughness as Record<string, unknown>).baseColorTexture, undefined);
    assert.deepEqual(bin, before.bin, "geometry bytes unchanged");
    // Valid container: declared length matches, chunks 4-byte aligned.
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    assert.equal(view.getUint32(8, true), out.byteLength);
    assert.equal(view.getUint32(12, true) % 4, 0);
  });

  it("leaves a GLB without matching materials unchanged in content", async () => {
    const glb = await sampleGlb();
    const { json } = readGlbJson(withExternalTextures(glb, new Map()));
    assert.equal(json.images, undefined);
    assert.equal(json.textures, undefined);
  });
});

describe("scanAssetDir with a manifest.json", () => {
  it("prefers the manifest and reports files it references but can't find", () => {
    const root = mkdtempSync(join(tmpdir(), "art-manifest-"));
    mkdirSync(join(root, "models", "glb", "pack"), { recursive: true });
    writeFileSync(join(root, "models", "glb", "pack", "crate.glb"), "glb");
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      name: "converted-packs",
      version: "2.0.0",
      models: [{ id: "pack/crate", file: "models/glb/pack/crate.glb" }],
      textures: [{ id: "pack/Atlas", file: "textures/pack/Atlas.png" }],
    }));
    const { manifest, diagnostics } = scanAssetDir(root);
    assert.equal(manifest.name, "converted-packs");
    assert.deepEqual(manifest.models.map((m) => m.id), ["pack/crate"]);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /textures\/pack\/Atlas\.png.*missing/);
  });

  it("falls back to scanning folders when the manifest is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "art-manifest-"));
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ name: "x", models: [] }));
    const { manifest, diagnostics } = scanAssetDir(root);
    assert.equal(manifest.version, "0.0.0-scan");
    assert.match(diagnostics[0], /manifest\.json is invalid/);
  });
});
