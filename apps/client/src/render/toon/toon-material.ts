/**
 * Toon shading for characters and creatures: the cel look of Genshin
 * Impact, applied to any MeshStandardMaterial (and its subclasses, such
 * as the modular character material) without replacing it.
 *
 * Adapted from KallkaGo's ToonShading (MIT, see THIRD_PARTY_NOTICES.md),
 * a WebGL study of Genshin's shading. Its body and face shaders are
 * ported onto three's own lighting, so every light in the scene (the
 * sun, the sky, FX lights) lights a toon surface with no extra wiring:
 *
 * - Diffuse: each light's half-Lambert term is cut into a lit band and a
 *   shadow band. The shadow takes its colour from a ramp texture: a row
 *   per material (skin, cloth, metal, leather, hair), with day and night
 *   variants. `setToonDay` fades between them with the sun.
 * - Light map (optional, the "ILM" map of the original): r is the
 *   specular mask (metal where r > 0.95), g the shadow bias (below 0.5
 *   always shadowed, as in creases; above it always lit), b the specular
 *   threshold, and a picks the ramp row. Without one, the whole surface
 *   uses one row (`row`) and a plain stepped highlight (`specular`).
 * - Metal: a matcap texture (optional), where the light map says metal.
 * - Rim light: a Fresnel rim, tinted by the lit colour. The original
 *   finds edges from a depth texture; this runs inside the scene pass,
 *   where the depth isn't there yet.
 * - Face (optional): the SDF face-shadow map, which moves the shadow
 *   across the face as the light turns about the head
 *   (`setFaceFrame` gives the head's forward and right).
 *
 * Outlines are separate meshes: see outline.ts.
 */

import * as THREE from "three";

/** Ramp rows (per material), in the default ramp and the light map's alpha buckets. */
export const TOON_ROWS = ["skin", "cloth", "metal", "leather", "hair"] as const;
export type ToonRow = (typeof TOON_ROWS)[number];

export interface ToonOptions {
  /**
   * The shadow ramp: 10 rows, top to bottom as authored, the 5 day rows then
   * the 5 night rows; left the darkest shadow, right the shadow's edge.
   * Default: `defaultToonRamp()`.
   */
  ramp?: THREE.Texture;
  /** The light map (see above), in the base map's UVs. Needs the material's `map`. */
  lightMap?: THREE.Texture;
  /** The ramp row without a light map. Default "cloth". */
  row?: ToonRow;
  /** Multiplies the ramp's shadow colour. Default white. */
  shadowColor?: THREE.ColorRepresentation;
  /** The half-Lambert band edges, shadow to lit. Default [0.42, 0.45]. */
  band?: [number, number];
  /** Stepped highlight strength without a light map (0 none). Default 0.15. */
  specular?: number;
  /** Rim light strength (0 none). Default 0.35. */
  rim?: number;
  /** Rim width: higher is thinner. Default 6. */
  rimPower?: number;
  /** Matcap for metal (needs `lightMap`). */
  matcap?: THREE.Texture;
  /** An SDF face-shadow map, in the base map's UVs (see `setFaceFrame`). */
  faceShadow?: THREE.Texture;
  /** How sharply the face shadow follows the light. Default 1. */
  faceSharpness?: number;
}

/** Uniforms shared by every toon material (the world sets them each frame). */
export const TOON_GLOBALS = {
  /** 0 night … 1 day. */
  uToonDay: { value: 1 },
};

/** Fade between the ramp's day and night rows (0 night … 1 day). */
export function setToonDay(day: number): void {
  TOON_GLOBALS.uToonDay.value = THREE.MathUtils.clamp(day, 0, 1);
}

/** How much it's day, from the sun's height above the horizon (a unit vector's y). */
export function toonDayFromSun(sunY: number): number {
  return THREE.MathUtils.smoothstep(sunY, -0.1, 0.15);
}

type Rgb = readonly [number, number, number];

/** Default shadow colours: [darkest, the shadow's edge] per row, day then night (linear RGB). */
const DEFAULT_RAMP: Record<ToonRow, { day: [Rgb, Rgb]; night: [Rgb, Rgb] }> = {
  skin: { day: [[0.62, 0.42, 0.42], [0.93, 0.78, 0.76]], night: [[0.36, 0.3, 0.42], [0.62, 0.56, 0.7]] },
  cloth: { day: [[0.5, 0.48, 0.6], [0.8, 0.78, 0.88]], night: [[0.28, 0.28, 0.42], [0.5, 0.52, 0.7]] },
  metal: { day: [[0.42, 0.44, 0.52], [0.78, 0.8, 0.86]], night: [[0.24, 0.26, 0.38], [0.48, 0.5, 0.64]] },
  leather: { day: [[0.52, 0.4, 0.36], [0.84, 0.72, 0.66]], night: [[0.3, 0.26, 0.36], [0.54, 0.48, 0.62]] },
  hair: { day: [[0.46, 0.4, 0.54], [0.82, 0.74, 0.86]], night: [[0.26, 0.24, 0.4], [0.5, 0.46, 0.68]] },
};

let sharedRamp: THREE.DataTexture | null = null;

/**
 * The default ramp: per row, a gradient from its darkest shadow to the
 * shadow's edge, with a short soft step near the edge (the look of
 * hand-painted ramps). Shared; don't dispose it.
 */
export function defaultToonRamp(): THREE.DataTexture {
  if (sharedRamp) return sharedRamp;
  const W = 64, H = 10;
  const data = new Uint8Array(W * H * 4);
  fillRamp(data, W, H);
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  sharedRamp = tex;
  return tex;
}

/** Paint the ramp rows from DEFAULT_RAMP into `data`. */
function fillRamp(data: Uint8Array, W: number, H: number): void {
  // Authored top-down: image row k (from the top) is texture row H-1-k (flipY is off).
  const put = (k: number, a: Rgb, b: Rgb): void => {
    const y = H - 1 - k;
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const t = THREE.MathUtils.smoothstep(u, 0, 0.35) * 0.55 + THREE.MathUtils.smoothstep(u, 0.7, 0.9) * 0.45;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(THREE.MathUtils.clamp(a[c] + (b[c] - a[c]) * t, 0, 1) * 255);
      data[o + 3] = 255;
    }
  };
  TOON_ROWS.forEach((row, k) => {
    put(k, ...DEFAULT_RAMP[row].day);
    put(k + 5, ...DEFAULT_RAMP[row].night);
  });
}

/** The toon look in force: the options a material starts from (content/materials/materials.json). */
const TOON_DEFAULTS = { band: [0.42, 0.45] as [number, number], specular: 0.15, rim: 0.35, rimPower: 6 };

/**
 * Set the toon look from content: the band, highlight and rim defaults, and
 * the ramp's shadow colours. The shared ramp is repainted in place, so
 * materials already built follow.
 */
export function setToonContent(toon: {
  band: [number, number];
  specular: number;
  rim: number;
  rimPower: number;
  ramp: Record<ToonRow, { day: [Rgb, Rgb]; night: [Rgb, Rgb] }>;
}): void {
  TOON_DEFAULTS.band = [...toon.band];
  TOON_DEFAULTS.specular = toon.specular;
  TOON_DEFAULTS.rim = toon.rim;
  TOON_DEFAULTS.rimPower = toon.rimPower;
  for (const row of TOON_ROWS) DEFAULT_RAMP[row] = toon.ramp[row];
  if (sharedRamp) {
    fillRamp(sharedRamp.image.data as Uint8Array, sharedRamp.image.width, sharedRamp.image.height);
    sharedRamp.needsUpdate = true;
  }
}

const PARS = /* glsl */ `
uniform sampler2D uToonRamp;
uniform float uToonRow;
uniform float uToonDay;
uniform vec3 uToonShadow;
uniform vec2 uToonBand;
uniform float uToonSpecular;
uniform float uToonRim;
uniform float uToonRimPower;
#ifdef TOON_LIGHTMAP
uniform sampler2D uToonLightMap;
#endif
#ifdef TOON_MATCAP
uniform sampler2D uToonMatcap;
#endif
#ifdef TOON_FACE
uniform sampler2D uToonFace;
uniform vec3 uToonFaceForward;
uniform vec3 uToonFaceRight;
uniform float uToonFaceSharpness;
#endif
// The light map's texel here (defaults: no specular, lit by the light, row from uToonRow).
vec4 toonIlm = vec4(0.0, 0.5, 0.0, -1.0);
vec2 toonUv = vec2(0.0);
vec3 toonLit = vec3(0.0);

// The ramp row (0..4) for this texel.
float toonRowHere() {
  if (toonIlm.a < 0.0) return uToonRow;
  // The light map's alpha, bucketed at 0, .3, .5, .7, 1.
  float a = toonIlm.a;
  return a < 0.15 ? 0.0 : a < 0.4 ? 1.0 : a < 0.6 ? 2.0 : a < 0.85 ? 3.0 : 4.0;
}

vec3 toonRamp(float u) {
  float row = toonRowHere();
  u = clamp(u, 0.003, 0.997);
  vec3 day = texture2D(uToonRamp, vec2(u, 1.0 - (row + 0.5) / 10.0)).rgb;
  vec3 night = texture2D(uToonRamp, vec2(u, 1.0 - (row + 5.5) / 10.0)).rgb;
  return mix(night, day, uToonDay);
}

void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  vec3 L = directLight.direction;
  float ndl = dot(geometryNormal, L);
  float halfLambert = pow(max(ndl, 0.0) * 0.5 + 0.5, 2.0);
  float lit = smoothstep(uToonBand.x, uToonBand.y, halfLambert);
#ifdef TOON_FACE
  // The face: the SDF map says where the shadow falls for the light's angle about the head.
  vec3 F = normalize((viewMatrix * vec4(uToonFaceForward, 0.0)).xyz);
  vec3 R = normalize((viewMatrix * vec4(uToonFaceRight, 0.0)).xyz);
  vec3 U = cross(F, R);
  vec3 Lh = normalize(L - dot(L, U) * U + 1e-5);
  float angle = acos(clamp(dot(Lh, R), -1.0, 1.0)) / PI;
  float exposeLeft = step(angle, 0.5);
  float thrL = pow(1.0 - clamp(angle, 0.0, 0.5) * 2.0, uToonFaceSharpness);
  float thrR = pow(clamp(angle, 0.5, 1.0) * 2.0 - 1.0, uToonFaceSharpness);
  float thr = mix(thrR, thrL, exposeLeft);
  float sdfL = texture2D(uToonFace, vec2(1.0 - toonUv.x, toonUv.y)).r;
  float sdfR = texture2D(uToonFace, toonUv).r;
  float sdf = mix(sdfL, sdfR, exposeLeft);
  lit = smoothstep(thr - 0.01, thr + 0.01, sdf) * step(0.0, dot(Lh, F));
  vec3 tint = mix(toonRamp(0.5) * uToonShadow, vec3(1.0), lit);
#else
  vec3 grey = toonRamp(smoothstep(0.2, 0.4, halfLambert)) * uToonShadow;
  vec3 dark = toonRamp(0.0) * uToonShadow;
  vec3 tint = mix(grey, vec3(1.0), lit);
  // Light map g: below .5 always in shadow (creases), above it lit whatever the angle.
  tint = mix(dark, tint, clamp(toonIlm.g * 2.0, 0.0, 1.0));
  tint = mix(tint, vec3(1.0), clamp(toonIlm.g - 0.5, 0.0, 1.0) * 2.0);
#endif
  vec3 diffuse = directLight.color * tint * BRDF_Lambert(material.diffuseColor);
  reflectedLight.directDiffuse += diffuse;
  toonLit += diffuse;

  // Specular: Blinn-Phong, stepped.
  vec3 H = normalize(geometryViewDir + L);
  float blinn = step(0.0, ndl) * pow(max(dot(geometryNormal, H), 0.0), 10.0);
  vec3 spec;
#ifdef TOON_LIGHTMAP
  float isMetal = step(0.95, toonIlm.r);
  vec3 plain = vec3(step(1.04 - blinn, toonIlm.b) * toonIlm.r);
  vec3 metal = blinn * toonIlm.b * (lit * 0.8 + 0.2) * material.diffuseColor;
  spec = mix(plain, metal, isMetal);
#else
  spec = vec3(step(0.9, blinn) * lit * uToonSpecular);
#endif
  reflectedLight.directSpecular += directLight.color * spec * RECIPROCAL_PI;
}
`;

// After the base map: read the light map where the texel is.
const MAP = /* glsl */ `
#include <map_fragment>
#ifdef USE_MAP
  toonUv = vMapUv;
#endif
#if defined(TOON_LIGHTMAP) && defined(USE_MAP)
  toonIlm = texture2D(uToonLightMap, vMapUv);
#endif
`;

// Before the output: metal matcap and the rim.
const OUT = /* glsl */ `
#ifdef TOON_MATCAP
  vec3 toonViewN = normalize(geometryNormal);
  vec3 toonMatcap = texture2D(uToonMatcap, toonViewN.xy * 0.5 + 0.5).rgb;
  outgoingLight += toonMatcap * diffuseColor.rgb * step(0.95, toonIlm.r);
#endif
  float toonFresnel = pow(1.0 - clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0), uToonRimPower);
  outgoingLight += (toonLit + diffuseColor.rgb * 0.1) * toonFresnel * uToonRim;
#include <opaque_fragment>
`;

/** A material's toon state, for later changes (face frame, row). */
export interface ToonHandle {
  readonly uniforms: {
    uToonRow: { value: number };
    uToonShadow: { value: THREE.Color };
    uToonFaceForward: { value: THREE.Vector3 };
    uToonFaceRight: { value: THREE.Vector3 };
  };
  /** The head's forward and right, world space (for the face shadow). */
  setFaceFrame(forward: THREE.Vector3, right: THREE.Vector3): void;
}

const handles = new WeakMap<THREE.Material, ToonHandle>();

/** The toon state of a material `applyToon` patched (undefined: not toon). */
export function toonOf(material: THREE.Material): ToonHandle | undefined {
  return handles.get(material);
}

/**
 * Shade `material` as toon. Keeps whatever it already does in its own
 * onBeforeCompile (the character material's recolouring, say): the toon
 * patch runs after it. Returns the handle for later changes. Applying it
 * twice changes nothing.
 */
export function applyToon<M extends THREE.MeshStandardMaterial>(material: M, o: ToonOptions = {}): ToonHandle {
  const existing = handles.get(material);
  if (existing) return existing;
  const uniforms = {
    uToonRamp: { value: o.ramp ?? defaultToonRamp() },
    uToonRow: { value: TOON_ROWS.indexOf(o.row ?? "cloth") },
    uToonDay: TOON_GLOBALS.uToonDay,
    uToonShadow: { value: new THREE.Color(o.shadowColor ?? 0xffffff) },
    uToonBand: { value: new THREE.Vector2(...(o.band ?? TOON_DEFAULTS.band)) },
    uToonSpecular: { value: o.specular ?? TOON_DEFAULTS.specular },
    uToonRim: { value: o.rim ?? TOON_DEFAULTS.rim },
    uToonRimPower: { value: o.rimPower ?? TOON_DEFAULTS.rimPower },
    uToonLightMap: { value: o.lightMap ?? null },
    uToonMatcap: { value: o.matcap ?? null },
    uToonFace: { value: o.faceShadow ?? null },
    uToonFaceForward: { value: new THREE.Vector3(0, 0, 1) },
    uToonFaceRight: { value: new THREE.Vector3(1, 0, 0) },
    uToonFaceSharpness: { value: o.faceSharpness ?? 1 },
  };
  const defines = [
    "#define TOON",
    o.lightMap ? "#define TOON_LIGHTMAP" : "",
    o.lightMap && o.matcap ? "#define TOON_MATCAP" : "",
    o.faceShadow ? "#define TOON_FACE" : "",
  ].filter(Boolean).join("\n");

  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    const fs = shader.fragmentShader;
    for (const chunk of ["#include <lights_physical_pars_fragment>", "#include <map_fragment>", "#include <opaque_fragment>"]) {
      if (!fs.includes(chunk)) throw new Error(`toon: the shader has no ${chunk} (not a MeshStandardMaterial?)`);
    }
    shader.fragmentShader = `${defines}\n${fs}`
      .replace(
        "#include <lights_physical_pars_fragment>",
        `#include <lights_physical_pars_fragment>\n${PARS}\n#undef RE_Direct\n#define RE_Direct RE_Direct_Toon`,
      )
      .replace("#include <map_fragment>", MAP)
      .replace("#include <opaque_fragment>", OUT);
  };
  const key = material.customProgramCacheKey.bind(material);
  const variant = `toon:${o.lightMap ? "L" : ""}${o.lightMap && o.matcap ? "M" : ""}${o.faceShadow ? "F" : ""}`;
  material.customProgramCacheKey = () => `${key()}|${variant}`;
  material.needsUpdate = true;

  const handle: ToonHandle = {
    uniforms,
    setFaceFrame(forward, right) {
      uniforms.uToonFaceForward.value.copy(forward).normalize();
      uniforms.uToonFaceRight.value.copy(right).normalize();
    },
  };
  handles.set(material, handle);
  return handle;
}
