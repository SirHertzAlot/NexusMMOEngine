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
 * wherever they exist and the coarse map fills in everywhere else. Next
 * to loaded chunks it also sinks a few metres (never below the sea):
 * the coarse map can stand above a chunk's border, and a view ray
 * skimming the border would then slip between the two into the sky.
 * Sunk, it's always below the border, where the chunks' skirts meet it.
 *
 * With surfaces (TERRAIN_SURFACES, surfaces.ts: photo-scanned CC0 ground
 * materials), the flat colours give way to textures: each biome's material
 * blended between the four nearest map cells (height-weighted, so grass
 * pokes through sand at the edges instead of cross-fading), rock on
 * slopes (triplanar), snow on the peaks, with their normal maps, roughness
 * and ambient occlusion. Without them the look is the flat one above.
 *
 * Colours are linear (three.js colour management): the ground texture is
 * sRGB and decoded on sampling.
 */

import * as THREE from "three";
import { MAX_SURFACE_LAYERS } from "./surfaces.js";

export interface TerrainUniforms {
  uGround: THREE.IUniform<THREE.Texture | null>;
  /** World rect covered by uGround: (x0, z0, sizeX, sizeZ). */
  uGroundRect: THREE.IUniform<THREE.Vector4>;
  uHasGround: THREE.IUniform<number>;
  uSnowLine: THREE.IUniform<number>;
  uLoaded: THREE.IUniform<THREE.Texture | null>;
  /** World rect covered by uLoaded, like uGroundRect. */
  uLoadedRect: THREE.IUniform<THREE.Vector4>;
  /** Far map cell size, metres: how far "next to a loaded chunk" reaches. */
  uFarCell: THREE.IUniform<number>;
  /** Sea level: the far map never sinks below it (NO_SEA: no sea). */
  uSeaLevel: THREE.IUniform<number>;
  /** Surfaces (only read with TERRAIN_SURFACES): colour+height and normal/roughness/AO arrays. */
  uSurfAlbedo: THREE.IUniform<THREE.Texture | null>;
  uSurfProps: THREE.IUniform<THREE.Texture | null>;
  /** Surface layer per map cell (R8), over uGroundRect. */
  uSurfLayers: THREE.IUniform<THREE.Texture | null>;
  uSurfLayersSize: THREE.IUniform<THREE.Vector2>;
  /** Per layer: metres per texture tile, and a linear albedo tint. */
  uSurfTile: THREE.IUniform<number[]>;
  uSurfTint: THREE.IUniform<THREE.Vector3[]>;
  uSurfRock: THREE.IUniform<number>;
  uSurfSnow: THREE.IUniform<number>;
}

/** How far the far map sinks next to loaded chunks, metres (the coarse/fine gap is ~2-3 m). */
export const FAR_SINK = 4;
/** "No sea level": nothing to stay above. */
export const NO_SEA = -1e6;

/** GLSL can't hold Infinity reliably: "no snow" is a line nothing reaches. */
export const NO_SNOW = 1e6;

const VERTEX_HEAD = /* glsl */ `
  varying vec3 vTerrainPos;
  varying vec3 vTerrainNormal;
#ifdef TERRAIN_FAR
  uniform sampler2D uLoaded;
  uniform vec4 uLoadedRect;
  uniform float uFarCell;
  uniform float uSeaLevel;
  float tLoaded(vec2 xz) {
    vec2 luv = (xz - uLoadedRect.xy) / uLoadedRect.zw;
    if (any(lessThan(luv, vec2(0.0))) || any(greaterThan(luv, vec2(1.0)))) return 0.0;
    return step(0.5, texture2D(uLoaded, luv).r);
  }
#endif
`;
const VERTEX_BODY = /* glsl */ `
#ifdef TERRAIN_FAR
  {
    vec2 xz = (modelMatrix * vec4(transformed, 1.0)).xz;
    float near = 0.0;
    for (int dz = -1; dz <= 1; dz++) {
      for (int dx = -1; dx <= 1; dx++) near = max(near, tLoaded(xz + vec2(float(dx), float(dz)) * uFarCell));
    }
    transformed.y -= near * clamp(transformed.y - uSeaLevel - 0.5, 0.0, ${FAR_SINK.toFixed(1)});
  }
#endif
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
#ifdef TERRAIN_SURFACES
  precision highp sampler2DArray;
  uniform sampler2DArray uSurfAlbedo;
  uniform sampler2DArray uSurfProps;
  uniform sampler2D uSurfLayers;
  uniform vec2 uSurfLayersSize;
  uniform float uSurfTile[${MAX_SURFACE_LAYERS}];
  uniform vec3 uSurfTint[${MAX_SURFACE_LAYERS}];
  uniform float uSurfRock;
  uniform float uSurfSnow;
  int tSurfLayerAt(ivec2 c) {
    c = clamp(c, ivec2(0), ivec2(uSurfLayersSize) - 1);
    return int(texelFetch(uSurfLayers, c, 0).r * 255.0 + 0.5);
  }
  void tSurf(int layer, vec2 p, out vec4 albedo, out vec4 props) {
    vec3 uvw = vec3(p / uSurfTile[layer], float(layer));
    albedo = texture(uSurfAlbedo, uvw);
    albedo.rgb *= uSurfTint[layer];
    props = texture(uSurfProps, uvw);
  }
#endif
`;

const FRAGMENT_BODY = /* glsl */ `
#ifdef TERRAIN_SURFACES
  // Read again by the normal and roughness chunks further down main().
  vec4 tSurfProps = vec4(0.5, 0.5, 1.0, 1.0);
#endif
  {
#ifdef TERRAIN_FAR
    vec2 luv = (vTerrainPos.xz - uLoadedRect.xy) / uLoadedRect.zw;
    if (all(greaterThanEqual(luv, vec2(0.0))) && all(lessThanEqual(luv, vec2(1.0)))
        && texture2D(uLoaded, luv).r > 0.5) discard;
#endif
    vec3 n = normalize(vTerrainNormal);
    float detail = tFbm(vTerrainPos.xz * 0.35);
    float slope = 1.0 - n.y; // 0 flat .. 1 vertical
    float rockNoise = tTriplanar(vTerrainPos * 0.45, n);
    float rockAmount = smoothstep(0.22, 0.42, slope + (rockNoise - 0.5) * 0.12);
    float snow = smoothstep(uSnowLine - 6.0, uSnowLine + 10.0, vTerrainPos.y + (detail - 0.5) * 18.0)
      * (1.0 - smoothstep(0.30, 0.55, slope));
#ifdef TERRAIN_SURFACES
    vec2 xz = vTerrainPos.xz;
    // The four map cells around this point, bilinear by position, sharpened by height.
    vec2 cellSize = uGroundRect.zw / uSurfLayersSize;
    vec2 cp = (xz - uGroundRect.xy) / cellSize - 0.5;
    ivec2 c0 = ivec2(floor(cp));
    vec2 f = fract(cp);
    int l0 = tSurfLayerAt(c0);
    int l1 = tSurfLayerAt(c0 + ivec2(1, 0));
    int l2 = tSurfLayerAt(c0 + ivec2(0, 1));
    int l3 = tSurfLayerAt(c0 + ivec2(1, 1));
    vec4 ga;
    vec4 gp;
    tSurf(l0, xz, ga, gp);
    if (l1 != l0 || l2 != l0 || l3 != l0) {
      vec4 a1, p1, a2, p2, a3, p3;
      tSurf(l1, xz, a1, p1);
      tSurf(l2, xz, a2, p2);
      tSurf(l3, xz, a3, p3);
      vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
      w *= vec4(ga.a, a1.a, a2.a, a3.a) + 0.35;
      w = w * w;
      w /= max(dot(w, vec4(1.0)), 1e-5);
      ga = ga * w.x + a1 * w.y + a2 * w.z + a3 * w.w;
      gp = gp * w.x + p1 * w.y + p2 * w.z + p3 * w.w;
    }
    vec3 color = ga.rgb * (0.88 + 0.24 * detail);
    vec4 props = gp;
    if (rockAmount > 0.001) {
      // Triplanar: the rock projected along each axis, weighted by the normal.
      vec3 tw = pow(abs(n), vec3(4.0));
      tw /= (tw.x + tw.y + tw.z);
      int rl = int(uSurfRock);
      vec4 ra, rp, sa, sp;
      vec4 rockA = vec4(0.0);
      vec4 rockP = vec4(0.0);
      tSurf(rl, vTerrainPos.zy, ra, rp); rockA += ra * tw.x; rockP += rp * tw.x;
      tSurf(rl, vTerrainPos.xz, sa, sp); rockA += sa * tw.y; rockP += sp * tw.y;
      tSurf(rl, vTerrainPos.xy, ra, rp); rockA += ra * tw.z; rockP += rp * tw.z;
      color = mix(color, rockA.rgb, rockAmount);
      // Rock's own bumps only read on the flat-ish part of the blend.
      props = mix(props, vec4(0.5, 0.5, rockP.z, rockP.w), rockAmount);
    }
    if (snow > 0.001) {
      vec4 sa, sp;
      tSurf(int(uSurfSnow), xz, sa, sp);
      color = mix(color, sa.rgb, snow);
      props = mix(props, sp, snow);
    }
    diffuseColor.rgb = color * mix(1.0, props.w, 0.8);
    tSurfProps = props;
#else
    vec3 ground = vec3(0.138, 0.254, 0.058);
    if (uHasGround > 0.5) ground = texture2D(uGround, (vTerrainPos.xz - uGroundRect.xy) / uGroundRect.zw).rgb;
    ground *= 0.82 + 0.36 * detail;
    vec3 rock = mix(vec3(0.155, 0.138, 0.117), vec3(0.305, 0.279, 0.238), rockNoise);
    vec3 color = mix(ground, rock, rockAmount);
    color = mix(color, vec3(0.83, 0.855, 0.888), snow);
    diffuseColor.rgb = color;
#endif
  }
`;

// Surfaces: the texture's roughness, and its normal map on the ground plane
// (u along +x, v along +z, OpenGL green-up), in view space like three's.
const ROUGHNESS_BODY = /* glsl */ `
#ifdef TERRAIN_SURFACES
  roughnessFactor = clamp(tSurfProps.z, 0.6, 1.0);
#endif
`;
const NORMAL_BODY = /* glsl */ `
#ifdef TERRAIN_SURFACES
  {
    vec3 nW = normalize(vTerrainNormal);
    vec2 tn = (tSurfProps.xy * 2.0 - 1.0) * 0.85;
    vec3 T = normalize(vec3(1.0, 0.0, 0.0) - nW * nW.x);
    vec3 B = normalize(vec3(0.0, 0.0, 1.0) - nW * nW.z);
    vec3 perturbed = normalize(T * tn.x + B * tn.y + nW * sqrt(max(0.0, 1.0 - dot(tn, tn))));
    normal = normalize((viewMatrix * vec4(perturbed, 0.0)).xyz);
  }
#endif
`;

export function createTerrainUniforms(): TerrainUniforms {
  return {
    uGround: { value: null },
    uGroundRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uHasGround: { value: 0 },
    uSnowLine: { value: NO_SNOW },
    uLoaded: { value: null },
    uLoadedRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uFarCell: { value: 16 },
    uSeaLevel: { value: NO_SEA },
    uSurfAlbedo: { value: null },
    uSurfProps: { value: null },
    uSurfLayers: { value: null },
    uSurfLayersSize: { value: new THREE.Vector2(1, 1) },
    uSurfTile: { value: new Array<number>(MAX_SURFACE_LAYERS).fill(4) },
    uSurfTint: { value: Array.from({ length: MAX_SURFACE_LAYERS }, () => new THREE.Vector3(1, 1, 1)) },
    uSurfRock: { value: 0 },
    uSurfSnow: { value: 0 },
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
      .replace("#include <color_fragment>", `#include <color_fragment>\n${FRAGMENT_BODY}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${ROUGHNESS_BODY}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${NORMAL_BODY}`);
  };
  material.customProgramCacheKey = () =>
    (far ? "mmo-terrain-far" : "mmo-terrain") + (material.defines?.TERRAIN_SURFACES !== undefined ? "+surfaces" : "");
  return material;
}
