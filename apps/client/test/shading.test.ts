/**
 * Shading components: which component a kind of thing carries, that the
 * content decides it (content/materials/materials.json -> shading), and
 * that applying one patches the material the way it says.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { TOON_ROWS, toonOf } from "../src/render/toon/toon-material.js";
import {
  applyShading,
  applyShadingToMaterial,
  setShadingContent,
  shadingFor,
  toonRowFor,
} from "../src/render/shading/shading.js";

const KINDS = ["model", "placeholder", "prefab"] as const;

const physical = (): { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string } => ({
  uniforms: {},
  vertexShader: THREE.ShaderLib.physical.vertexShader,
  fragmentShader: THREE.ShaderLib.physical.fragmentShader,
});
const compile = (m: THREE.Material, shader = physical()) => {
  m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader;
};

describe("shading components", () => {
  it("gives every kind the cel look by default", () => {
    setShadingContent(undefined);
    for (const kind of KINDS) assert.deepEqual(shadingFor(kind), ["toon"], kind);
  });

  it("lets the content decide who is cell-shaded, kind by kind", () => {
    setShadingContent({ kinds: { model: ["standard"] } });
    assert.deepEqual(shadingFor("model"), ["standard"]);
    assert.deepEqual(shadingFor("prefab"), ["toon"], "a kind the content does not name keeps the default");
    setShadingContent(undefined);
  });

  it("takes the toon ramp row from the content, per kind", () => {
    setShadingContent({ rows: { model: "metal" } });
    assert.equal(toonRowFor("model"), "metal");
    assert.equal(toonRowFor("placeholder"), "leather", "a kind the content does not name keeps the default");
    setShadingContent(undefined);
  });

  it("patches a toon material and leaves a standard one alone", () => {
    setShadingContent(undefined);
    const cel = new THREE.MeshStandardMaterial();
    applyShadingToMaterial(cel, "model");
    assert.ok(toonOf(cel), "toon: patched");
    assert.match(compile(cel).fragmentShader, /#define RE_Direct RE_Direct_Toon/);

    setShadingContent({ kinds: { model: ["standard"] } });
    const plain = new THREE.MeshStandardMaterial();
    applyShadingToMaterial(plain, "model");
    assert.equal(toonOf(plain), undefined, "standard: three's own PBR, untouched");
    setShadingContent(undefined);
  });

  it("uses the kind's ramp row for the patch", () => {
    setShadingContent({ rows: { prefab: "metal" } });
    const m = new THREE.MeshStandardMaterial();
    applyShadingToMaterial(m, "prefab");
    assert.equal(toonOf(m)!.uniforms.uToonRow.value, TOON_ROWS.indexOf("metal"));
    setShadingContent(undefined);
  });

  it("shades every mesh under an object, a list of materials included", () => {
    setShadingContent(undefined);
    const single = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    const multi = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [
      new THREE.MeshStandardMaterial(),
      new THREE.MeshStandardMaterial(),
    ]);
    const other = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    const group = new THREE.Group();
    group.add(single, multi, other);
    applyShading(group, "placeholder");
    assert.ok(toonOf(single.material as THREE.Material), "a single material");
    for (const m of multi.material as THREE.Material[]) assert.ok(toonOf(m), "each of a list");
    assert.equal(toonOf(other.material as THREE.Material), undefined, "a material that is not standard");
  });

  it("the shipped content makes models, stand-ins and prefabs cell-shaded", () => {
    const doc = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../../content/materials/materials.json", import.meta.url)), "utf8"),
    ) as { shading?: unknown };
    assert.ok(doc.shading, "content/materials/materials.json declares shading");
    setShadingContent(doc.shading as Parameters<typeof setShadingContent>[0]);
    for (const kind of KINDS) assert.ok(shadingFor(kind).includes("toon"), `${kind} is cell-shaded`);
    setShadingContent(undefined);
  });
});
