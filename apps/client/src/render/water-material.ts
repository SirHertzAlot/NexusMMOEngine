/**
 * The water's look, in one shader pass (no reflection or refraction render
 * targets):
 *
 *  - Waves: three crossing swell trains, bent over broad regions so they
 *    don't tile, plus fine ripples; they only tilt the normal (the sheets
 *    stay flat), and the detail fades with distance so far water doesn't
 *    shimmer.
 *  - Reflection: the sky itself, evaluated in the reflected direction with
 *    the sky dome's own function and uniforms, weighted by Fresnel, so the
 *    water mirrors the hour: blue at noon, orange at dusk, stars at night.
 *  - Sun glint: a sharp GGX highlight (bright enough for bloom).
 *  - Body: light absorbed with depth, from clear shallows to dark deep
 *    water; shallow water is see-through to the ground under it.
 *  - Shore foam: a broken, moving band where the water is under a metre.
 *  - The scene fog, so far water fades into the haze with everything else.
 *
 * Depth comes from the world map (16 m cells), so the shallows and foam
 * follow the map's shoreline, not every rock of the streamed terrain.
 *
 * The wave field, Fresnel and GGX terms are adapted from ProceduralTerrains'
 * waterWavesGLSL.js and waterOpticsGLSL.js (MIT, © 2026 ZyFou; see
 * THIRD_PARTY_NOTICES.md).
 */

import * as THREE from "three";
import type { WorldMap } from "@mmo-engine/protocol";
import { SKY_EVAL_GLSL, SKY_UNIFORMS_GLSL, type SkyUniforms } from "./sky/sky-glsl.js";

const VERTEX = /* glsl */ `
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
${SKY_UNIFORMS_GLSL}
${SKY_EVAL_GLSL}
uniform float uTime;
uniform sampler2D uDepthMap;
uniform vec4 uDepthRect;   // x0, z0, width, depth of the map, metres
uniform float uHasDepth;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform float uRainIntensity; // 0..1, from the weather field
varying vec3 vWorld;
#include <fog_pars_fragment>

const float F0 = 0.02037;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}

vec2 rotate2(vec2 d, float a) {
  float c = cos(a), s = sin(a);
  return vec2(d.x * c - d.y * s, d.x * s + d.y * c);
}

// Height slope d(h)/d(x, z) of the wave field.
vec2 waveSlope(vec2 p, float t, float detail) {
  // Broad, slow bending of the phase so the trains never tile.
  float macroA = sin(dot(p, vec2(0.00417, 0.00531)) + t * 0.027);
  float macroB = sin(dot(p, vec2(-0.00613, 0.00377)) - t * 0.019 + macroA * 0.43);
  vec2 q = p + vec2(macroA, macroB - macroA * 0.38) * 7.0;

  vec2 dA = normalize(vec2(0.8, 0.6));
  vec2 dB = rotate2(dA, 0.6108652);
  vec2 dC = rotate2(dA, 0.9250245);
  // (wavenumber, amplitude, speed) per train, metres and seconds.
  vec3 A = vec3(0.176, 0.28, 1.1);
  vec3 B = vec3(0.228, 0.16, 0.9);
  vec3 C = vec3(0.335, 0.08, 1.5);
  vec2 s = dA * A.x * A.y * cos(dot(q, dA) * A.x + t * A.z)
         + dB * B.x * B.y * cos(dot(q, dB) * B.x - t * B.z)
         + dC * C.x * C.y * cos(dot(q, dC) * C.x + t * C.z);
  // Capillary ripples, only up close.
  vec2 dD = rotate2(dA, 2.1);
  vec2 dE = rotate2(dA, -1.3);
  s += detail * (dD * 1.9 * 0.012 * cos(dot(p, dD) * 1.9 + t * 2.6)
               + dE * 3.1 * 0.007 * cos(dot(p, dE) * 3.1 - t * 3.4));
  // Rain ripples (WX1): high-frequency, small-amplitude, driven by the field.
  float rain = uRainIntensity;
  if (rain > 0.001) {
    vec2 dR1 = rotate2(dA, 1.7);
    vec2 dR2 = rotate2(dA, -0.9);
    s += rain * (dR1 * 8.0 * 0.004 * cos(dot(p, dR1) * 8.0 + t * 5.2)
               + dR2 * 12.0 * 0.003 * cos(dot(p, dR2) * 12.0 - t * 6.1));
  }
  return s;
}

float ggxSpecular(vec3 n, vec3 v, vec3 l, float roughness) {
  float noV = max(dot(n, v), 0.001);
  float noL = max(dot(n, l), 0.0);
  if (noL <= 0.0) return 0.0;
  vec3 h = normalize(v + l);
  float noH = max(dot(n, h), 0.0);
  float voH = max(dot(v, h), 0.0);
  float a = max(roughness * roughness, 0.0025);
  float a2 = a * a;
  float d = noH * noH * (a2 - 1.0) + 1.0;
  float dist = a2 / max(3.14159265 * d * d, 0.0001);
  float k = (roughness + 1.0) * (roughness + 1.0) * 0.125;
  float g = (noV / (noV * (1.0 - k) + k)) * (noL / (noL * (1.0 - k) + k));
  float f = F0 + (1.0 - F0) * pow(1.0 - voH, 5.0);
  return dist * g * f * noL / max(4.0 * noV * noL, 0.001);
}

void main() {
  vec2 p = vWorld.xz;
  vec3 toCamera = cameraPosition - vWorld;
  float dist = length(toCamera);
  vec3 v = toCamera / max(dist, 0.0001);
  float detail = 1.0 - smoothstep(40.0, 300.0, dist);
  vec2 slope = waveSlope(p, uTime, detail) * mix(0.3, 1.0, 1.0 - smoothstep(200.0, 2000.0, dist));
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

  float depth = uHasDepth > 0.5 ? texture2D(uDepthMap, (p - uDepthRect.xy) / uDepthRect.zw).r : 40.0;
  depth = max(depth, 0.0);

  // Light on the water body: sun (or moon glow), sky, and a night floor.
  float sunUp = smoothstep(-0.05, 0.1, uSunDir.y);
  vec3 sunLight = uSunColor * uLight * max(uSunDir.y, 0.0) * 0.55;
  vec3 skyLight = mix(uHorizon, uZenith, 0.5) * 0.9;
  vec3 light = max(sunLight + skyLight, vec3(0.035, 0.045, 0.07));

  vec3 color;
  float alpha;
  if (gl_FrontFacing) {
    float fresnel = F0 + (1.0 - F0) * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);
    vec3 r = reflect(-v, n);
    r.y = abs(r.y);
    vec3 reflection = evaluateSky(r, 0.0, 0.6);

    // Beer-Lambert: red goes first; the path through the water is longer at grazing angles.
    float path = depth / max(v.y, 0.2);
    vec3 transmit = exp(-vec3(0.34, 0.11, 0.06) * path);
    vec3 body = mix(uDeep, uShallow, transmit) * light;
    float bodyAlpha = mix(0.35, 0.97, 1.0 - dot(transmit, vec3(0.2126, 0.7152, 0.0722)));

    float glint = ggxSpecular(n, v, normalize(uSunDir), 0.07) * sunUp;
    color = mix(body, reflection, fresnel) + uSunColor * uLight * glint * 0.6;
    alpha = max(bodyAlpha, fresnel);

    // Shore foam: a broken, moving band in the last metre.
    float shore = 1.0 - smoothstep(0.15, 1.1, depth);
    float n1 = valueNoise(p * 0.45 + vec2(uTime * 0.21, -uTime * 0.17));
    float n2 = valueNoise(p * 1.3 - vec2(uTime * 0.35, uTime * 0.12));
    float bands = 0.5 + 0.5 * sin(depth * 9.0 - uTime * 1.6 + n1 * 4.0);
    float foam = shore * smoothstep(0.45, 0.8, n1 * 0.55 + n2 * 0.25 + bands * 0.35) * uHasDepth;
    color = mix(color, uFoam * light, foam * 0.85);
    alpha = max(alpha, foam);
  } else {
    // From below: the surface glows with the light above, darker at grazing angles.
    float up = clamp(-v.y, 0.0, 1.0);
    color = mix(uDeep * light, evaluateSky(vec3(-v.x, abs(v.y), -v.z), 0.0, 0.0) * 0.55, pow(up, 3.0));
    alpha = 0.92;
  }

  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface WaterUniforms {
  [name: string]: THREE.IUniform;
}

/** The water material, bound to the sky's uniforms (the same objects, so reflections follow the sky). */
export function createWaterMaterial(sky: SkyUniforms): { material: THREE.ShaderMaterial; uniforms: WaterUniforms } {
  const own: WaterUniforms = {
    uTime: { value: 0 },
    uDepthMap: { value: null },
    uDepthRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uHasDepth: { value: 0 },
    uShallow: { value: new THREE.Color(0.1, 0.42, 0.44) },
    uDeep: { value: new THREE.Color(0.012, 0.07, 0.11) },
    uFoam: { value: new THREE.Color(0.9, 0.95, 1.0) },
    uRainIntensity: { value: 0 },
  };
  const uniforms: WaterUniforms = { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...sky, ...own };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    side: THREE.DoubleSide,
    fog: true,
  });
  material.name = "water";
  return { material, uniforms };
}

/**
 * Water depth per map cell (surface minus ground, metres; 0 on dry
 * ground), as a linearly filtered half-float texture: the shader reads the
 * shallows and the shore from it. Null when the map has no water layer.
 */
export function waterDepthTexture(map: WorldMap): THREE.DataTexture | null {
  const water = map.water;
  if (!water) return null;
  const n = map.width * map.depth;
  const data = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const w = water[i];
    const d = Number.isNaN(w) ? 0 : Math.max(0, w - map.heights[i]);
    data[i] = THREE.DataUtils.toHalfFloat(Math.min(d, 500));
  }
  const tex = new THREE.DataTexture(data, map.width, map.depth, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** The map's extent for the depth lookup: (x0, z0, width, depth) in metres, cell edges not centres. */
export function waterDepthRect(map: WorldMap): THREE.Vector4 {
  return new THREE.Vector4(
    map.originX - map.cell / 2,
    map.originZ - map.cell / 2,
    map.width * map.cell,
    map.depth * map.cell,
  );
}
