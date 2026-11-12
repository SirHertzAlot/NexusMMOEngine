/**
 * Unified cel shading: every world class is cel or carries a recorded
 * opt-out, the cel band follows the quality tier's feather, and the
 * registry matches the art package's shading kinds.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SHADING_KINDS, SHADING_OPT_OUTS, SHADING_OUTLINE_OPT_OUTS } from "@mmo-engine/art/browser";
import { defaultToonRampRows, toonOf } from "../src/render/toon/toon-material.js";
import {
  applyShadingToMaterial,
  celBand,
  setCelFeather,
  setCelOutlines,
  setShadingContent,
  shadeWorldObject,
  shadingFor,
} from "../src/render/shading/shading.js";
import { WORLD_CLASSES, optOutOf, outlineOptOutOf } from "../src/render/shading/world-classes.js";
import { QUALITY_PRESETS, QUALITY_TIERS } from "../src/render/quality.js";

describe("world shading registry", () => {
  it("every world class is cel or carries a non-empty opt-out reason", () => {
    for (const c of WORLD_CLASSES) {
      if ("kind" in c.path) {
        assert.ok(SHADING_KINDS.includes(c.path.kind), `${c.id}: kind ${c.path.kind} is in the art schema`);
      } else {
        const reason = optOutOf(c);
        assert.ok(reason && reason.length > 0, `${c.id}: opt-out needs a reason`);
      }
    }
  });

  it("every cel class resolves to the toon patch by default", () => {
    setShadingContent(undefined);
    for (const c of WORLD_CLASSES) {
      if (!("kind" in c.path)) continue;
      const m = new THREE.MeshStandardMaterial();
      applyShadingToMaterial(m, c.path.kind);
      assert.ok(shadingFor(c.path.kind).includes("toon"), `${c.id}: default kind is cel`);
      assert.ok(toonOf(m), `${c.id}: a standard material takes the toon patch`);
    }
  });

  it("covers every art shading kind, so none is left unshaded by accident", () => {
    const used = new Set(WORLD_CLASSES.flatMap((c) => ("kind" in c.path ? [c.path.kind] : [])));
    for (const kind of SHADING_KINDS) assert.ok(used.has(kind), `kind ${kind} is used by some world class`);
  });

  it("every opt-out in the art record is used by some world class", () => {
    const used = new Set(WORLD_CLASSES.flatMap((c) => ("optOut" in c.path ? [c.path.optOut] : [])));
    for (const id of Object.keys(SHADING_OPT_OUTS)) assert.ok(used.has(id as keyof typeof SHADING_OPT_OUTS), `${id} is used`);
  });
});

describe("cel band feather", () => {
  it("a hard tier gives a step (zero width)", () => {
    setCelFeather(0);
    const [lo, hi] = celBand();
    assert.equal(lo, hi);
  });

  it("a feathered tier gives the content's band width", () => {
    setCelFeather(0.03);
    const [lo, hi] = celBand();
    assert.ok(Math.abs(hi - lo - 0.03) < 1e-9, `width ${hi - lo}`);
    setCelFeather(0);
  });

  it("the low tier is hard, the others feathered", () => {
    assert.equal(QUALITY_PRESETS.low.celFeather, 0);
    for (const t of QUALITY_TIERS.filter((t) => t !== "low")) assert.ok(QUALITY_PRESETS[t].celFeather > 0, t);
  });
});

describe("cel outlines on world geometry", () => {
  const mesh = (): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  const outlines = (o: THREE.Object3D): number => o.children.filter((c) => c.name.endsWith(":outline")).length;

  it("draws an outline on a cel model when the tier allows", () => {
    setShadingContent(undefined);
    setCelOutlines(true);
    const m = mesh();
    shadeWorldObject(m, "model");
    assert.equal(outlines(m), 1);
    setCelOutlines(false);
  });

  it("draws none on a low tier", () => {
    setCelOutlines(false);
    const m = mesh();
    shadeWorldObject(m, "model");
    assert.equal(outlines(m), 0);
  });

  it("never outlines terrain or an instanced batch (their recorded opt-outs)", () => {
    setCelOutlines(true);
    const t = mesh();
    shadeWorldObject(t, "terrain");
    assert.equal(outlines(t), 0, "terrain has an opt-out");
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), 2);
    shadeWorldObject(inst, "model", "instanced");
    assert.equal(outlines(inst), 0, "instanced batch has an opt-out");
    setCelOutlines(false);
  });

  it("every outlined cel class is outlined by default, every opt-out carries a reason", () => {
    for (const c of WORLD_CLASSES) {
      if (!("kind" in c.path)) continue;
      const reason = outlineOptOutOf(c);
      if (reason === null) continue;
      assert.ok(reason.length > 0, `${c.id}: outline opt-out has a reason`);
    }
    for (const [id, reason] of Object.entries(SHADING_OUTLINE_OPT_OUTS)) assert.ok(reason.length > 0, id);
  });
});

describe("the authored cel ramp", () => {
  it("the client's fallback ramp matches the content's toon.ramp (no drift)", () => {
    const doc = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../content/materials/materials.json", import.meta.url)), "utf8"));
    assert.deepEqual(defaultToonRampRows(), doc.toon.ramp);
  });
});

describe("terrain mask on the cel terrain", () => {
  it("the terrain material samples the mask and stays cel", async () => {
    const { createTerrainMaterial, createTerrainUniforms, packTerrainMask } = await import("../src/render/terrain/terrain-material.js");
    const uniforms = createTerrainUniforms();
    const material = createTerrainMaterial(uniforms, false);
    applyShadingToMaterial(material, "terrain");
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: "#include <common>\n#include <begin_vertex>",
      fragmentShader: "#include <common>\n#include <color_fragment>\n#include <lights_physical_pars_fragment>\n#include <map_fragment>\n#include <opaque_fragment>",
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    assert.match(shader.fragmentShader, /texture2D\(uMask,/, "mask sampled");
    assert.match(shader.fragmentShader, /RE_Direct_Toon/, "still cel");
    const channels = { base: new Uint8Array(4), rock: new Uint8Array([0, 255, 0, 0]), wet: new Uint8Array(4), path: new Uint8Array(4) };
    const tex = packTerrainMask(channels, 2, 2);
    assert.equal((tex.image.data as Uint8Array)[1 * 4 + 1], 255, "rock packed into G of sample 1");
    tex.dispose();
  });
});
