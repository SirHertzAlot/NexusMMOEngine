/**
 * Terrain material: one opaque MeshStandardMaterial shared by every chunk
 * (and a second one for the far horizon), shaded from world position and
 * surface normal instead of per-chunk state:
 *
 *  - ground: the biome colour under the fragment (a texture baked from
 *    the world map, see ground.ts), with fine noise so it doesn't look flat
 *  - rock: steep faces blend to rock, patterned by noise projected along
 *    the normal's dominant axes (triplanar) so cliffs don't smear
 *  - snow: flatter ground above the world's snow line
 *
 * The far-horizon variant discards fragments over loaded chunks (a mask
 * texture with one texel per world chunk), so the detailed chunks show
 * wherever they exist and the coarse map fills in everywhere else.
 *
 * Colours are linear (three.js colour management): the ground texture is
 * sRGB and decoded on sampling.
 */

import * as THREE from "three";

export interface TerrainUniforms {
  uGround: THREE.IUniform<THREE.Texture | null>;
  /** World rect covered by uGround: (x0, z0, sizeX, sizeZ). */
  uGroundRect: THREE.IUniform<THREE.Vector4>;
  uHasGround: THREE.IUniform<number>;
  uSnowLine: THREE.IUniform<number>;
  uLoaded: THREE.IUniform<THREE.Texture | null>;
  /** World rect covered by uLoaded, like uGroundRect. */
  uLoadedRect: THREE.IUniform<THREE.Vector4>;
}

/** GLSL can't hold Infinity reliably: "no snow" is a line nothing reaches. */
export const NO_SNOW = 1e6;

const VERTEX_HEAD = /* glsl */ `
  varying vec3 vTerrainPos;
  varying vec3 vTerrainNormal;
`;
const VERTEX_BODY = /* glsl */ `
  vTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);
`;

const FRAGMENT_HEAD = /* glsl */ `
  varying vec3 vTerrainPos;
  varying vec3 vTerrainNormal;
  uniform sampler2D uGround;
  uniform vec4 uGroundRect;
  uniform float uHasGround;
  uniform float uSnowLine;
  uniform sampler2D uLoaded;
  uniform vec4 uLoadedRect;

  // Hash without sin(): stable at world coordinates in the thousands.
  float tHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float tNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x),
               mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float tFbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int k = 0; k < 4; k++) {
      v += a * tNoise(p);
      p = p * 2.03 + vec2(17.3, 9.1);
      a *= 0.5;
    }
    return v;
  }
  // Noise projected along each axis, weighted by the normal: no stretching on cliffs.
  float tTriplanar(vec3 p, vec3 n) {
    vec3 w = abs(n);
    w /= (w.x + w.y + w.z);
    return tFbm(p.zy) * w.x + tFbm(p.xz) * w.y + tFbm(p.xy) * w.z;
  }
`;

const FRAGMENT_BODY = /* glsl */ `
  {
#ifdef TERRAIN_FAR
    vec2 luv = (vTerrainPos.xz - uLoadedRect.xy) / uLoadedRect.zw;
    if (all(greaterThanEqual(luv, vec2(0.0))) && all(lessThanEqual(luv, vec2(1.0)))
        && texture2D(uLoaded, luv).r > 0.5) discard;
#endif
    vec3 n = normalize(vTerrainNormal);
    vec3 ground = vec3(0.138, 0.254, 0.058);
    if (uHasGround > 0.5) ground = texture2D(uGround, (vTerrainPos.xz - uGroundRect.xy) / uGroundRect.zw).rgb;
    float detail = tFbm(vTerrainPos.xz * 0.35);
    ground *= 0.82 + 0.36 * detail;

    float slope = 1.0 - n.y; // 0 flat .. 1 vertical
    float rockNoise = tTriplanar(vTerrainPos * 0.45, n);
    vec3 rock = mix(vec3(0.155, 0.138, 0.117), vec3(0.305, 0.279, 0.238), rockNoise);
    float rockAmount = smoothstep(0.22, 0.42, slope + (rockNoise - 0.5) * 0.12);
    vec3 color = mix(ground, rock, rockAmount);

    float snow = smoothstep(uSnowLine - 6.0, uSnowLine + 10.0, vTerrainPos.y + (detail - 0.5) * 18.0)
      * (1.0 - smoothstep(0.30, 0.55, slope));
    color = mix(color, vec3(0.83, 0.855, 0.888), snow);
    diffuseColor.rgb = color;
  }
`;

export function createTerrainUniforms(): TerrainUniforms {
  return {
    uGround: { value: null },
    uGroundRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uHasGround: { value: 0 },
    uSnowLine: { value: NO_SNOW },
    uLoaded: { value: null },
    uLoadedRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  };
}

/**
 * A terrain material bound to shared `uniforms` (update them in place and
 * every material using them follows). `far`: the horizon variant.
 */
export function createTerrainMaterial(uniforms: TerrainUniforms, far = false): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  if (far) material.defines = { TERRAIN_FAR: "" };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_HEAD}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_HEAD}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${FRAGMENT_BODY}`);
  };
  material.customProgramCacheKey = () => (far ? "mmo-terrain-far" : "mmo-terrain");
  return material;
}
