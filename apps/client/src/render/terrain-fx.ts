/**
 * Terrain FX — animated placeholder-terrain shader.
 *
 * Terrain geometry comes from the server's heightfield; all FX is
 * fragment-shader work injected into the standard terrain material via
 * `onBeforeCompile`. Lighting, fog, and the HUD wireframe toggle keep
 * working untouched.
 *
 * Layers (all driven by world-space xz + the world seed):
 *  - albedo variation: grass/dirt/rock patches from fbm noise
 *  - energy veins: ridged-noise emissive cracks with a pulse that
 *    travels along the vein
 *  - water shimmer: low-mask pools with animated sparkle
 *
 * `applyTerrainFx()` hooks a material once; `updateTerrainFx()` must be
 * called every frame (WorldCanvas does this) to advance `uTime`.
 */

import * as THREE from "three";
import { NOISE_GLSL } from "./glsl.js";

interface CompiledShader {
  uniforms: Record<string, THREE.IUniform>;
}

/**
 * Live compiled shader per hooked material. Keyed by material so a
 * recompile (e.g. the wireframe toggle) replaces the entry instead of
 * adding one, and removed when the material is disposed — otherwise every
 * chunk, rebuild, and reconnect leaks a shader that updateTerrainFx keeps
 * iterating every frame.
 */
const activeShaders = new Map<THREE.Material, CompiledShader>();

const NOISE_CHUNK = NOISE_GLSL;

const FRAGMENT_HEAD = /* glsl */ `
  varying vec3 vFxWorldPos;
  uniform float uTime;
  uniform float uSeed;
  ${NOISE_CHUNK}
`;

const ALBEDO_GLSL = /* glsl */ `
  {
    vec2 tp = vFxWorldPos.xz * 0.18 + uSeed * 0.37;
    float patches = fxFbm(tp);
    float detail = fxFbm(tp * 3.1 + 5.2);
    vec3 grass = vec3(0.196, 0.353, 0.180);
    vec3 dirt  = vec3(0.352, 0.256, 0.156);
    vec3 rock  = vec3(0.298, 0.298, 0.318);
    vec3 alb = mix(grass, dirt, smoothstep(0.38, 0.72, patches));
    alb = mix(alb, rock, smoothstep(0.55, 0.85, detail) * 0.7);
    // subtle large-scale tonal drift so chunks don't look tiled
    alb *= 0.92 + 0.16 * fxFbm(tp * 0.23);
    diffuseColor.rgb = alb;
  }
`;

const EMISSIVE_GLSL = /* glsl */ `
  {
    vec2 tp = vFxWorldPos.xz * 0.18 + uSeed * 0.37;
    // Energy veins: sharp ridged lines, pulse travels along them.
    float ridge = fxRidge(tp * 0.9 + vec2(uSeed));
    float vein = pow(smoothstep(0.72, 0.97, ridge), 2.0);
    float travel = 0.55 + 0.45 * sin(uTime * 2.2 - ridge * 14.0 + uSeed);
    vec3 veinColor = vec3(0.15, 0.85, 1.0);
    // Water pools: low fbm mask with animated sparkle.
    float pool = smoothstep(0.60, 0.72, fxFbm(tp * 0.7 + 3.7));
    float sparkle = pow(fxNoise(vFxWorldPos.xz * 6.0 + uTime * 0.7), 6.0);
    vec3 waterColor = vec3(0.15, 0.45, 0.75);
    totalEmissiveRadiance += veinColor * (vein * travel * 1.6)
      + waterColor * (pool * (0.25 + sparkle * 1.4));
  }
`;

/**
 * Hook FX into a terrain material. Idempotent per material instance —
 * call once when the mesh is created (PlaceholderAssets.terrainMesh).
 */
export function applyTerrainFx(
  material: THREE.MeshStandardMaterial,
  seed: number,
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uSeed = { value: seed };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vFxWorldPos;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvFxWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_HEAD}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${ALBEDO_GLSL}`)
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${EMISSIVE_GLSL}`,
      );
    activeShaders.set(material, shader as CompiledShader);
  };
  material.addEventListener("dispose", () => activeShaders.delete(material));
  // Every hooked material shares this injection; one cache key is enough.
  material.customProgramCacheKey = () => "mmo-terrain-fx";
}

/** Live hooked materials (leak regression checks). */
export function activeTerrainFxCount(): number {
  return activeShaders.size;
}

/** Advance all terrain FX clocks. Call once per frame. */
export function updateTerrainFx(timeSeconds: number): void {
  for (const s of activeShaders.values()) {
    const u = s.uniforms["uTime"];
    if (u) u.value = timeSeconds;
  }
}
