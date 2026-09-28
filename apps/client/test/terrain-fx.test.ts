/**
 * Terrain FX lifetime: hooked materials must release their compiled
 * shader on dispose and replace (not accumulate) it on recompile —
 * otherwise every chunk, rebuild, wireframe toggle, and reconnect leaks a
 * shader that updateTerrainFx keeps iterating every frame.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  activeTerrainFxCount,
  applyTerrainFx,
  updateTerrainFx,
} from "../src/render/terrain-fx.js";

/** What three.js hands onBeforeCompile (only the fields the hook touches). */
function fakeShader(): THREE.WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader:
      "#include <common>\n#include <color_fragment>\n#include <emissivemap_fragment>",
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
}

function compile(material: THREE.Material): THREE.WebGLProgramParametersWithUniforms {
  const shader = fakeShader();
  material.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
  return shader;
}

describe("terrain FX lifetime", () => {
  it("dispose releases the material's shader", () => {
    const base = activeTerrainFxCount();
    const mats = [0, 1, 2].map((seed) => {
      const m = new THREE.MeshStandardMaterial();
      applyTerrainFx(m, seed);
      compile(m);
      return m;
    });
    assert.equal(activeTerrainFxCount(), base + 3);
    for (const m of mats) m.dispose();
    assert.equal(activeTerrainFxCount(), base);
  });

  it("a recompile replaces the shader instead of adding one", () => {
    const base = activeTerrainFxCount();
    const m = new THREE.MeshStandardMaterial();
    applyTerrainFx(m, 7);
    compile(m);
    const latest = compile(m); // e.g. wireframe toggle -> new program
    assert.equal(activeTerrainFxCount(), base + 1);
    updateTerrainFx(12.5);
    assert.equal(latest.uniforms["uTime"]!.value, 12.5, "clock drives the live shader");
    m.dispose();
    assert.equal(activeTerrainFxCount(), base);
  });
});
