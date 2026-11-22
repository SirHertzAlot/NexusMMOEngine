import * as THREE from "three";
import type { FxMessage } from "@mmo-engine/protocol";
import {
  createEffectRuntime,
  sampleSpline,
  type EffectDefinition,
  type EffectRendererHooks,
  type FxTier,
  type FxWireMessage,
  type LiveEffectState,
  type ParamValue,
  type ManagedEffectRuntime,
} from "@mmo-engine/render-fx";
import { NOISE_GLSL } from "../glsl.js";

export type EntityPositionResolver = (entityId: bigint, out: THREE.Vector3) => boolean;

const MAX_PARTICLES = 1024;
const RING_POOL_SIZE = 24;
const HIT_SLOTS = 8;
const PREVIEW_SAMPLES = 48;
const PREVIEW_HALF_WIDTH_M = 0.48;
const SPLINE_LINE_SAMPLES = 44;
const SPLINE_SPIKE_COUNT = 7;

// Element shader modes matching PoolModule modes & assetIds
// 0 = generic/mend, 1 = fire, 2 = water, 3 = earth, 4 = air, 5 = lightning, 6 = frost
function resolveElementMode(assetId: string, poolMode: number): number {
  if (poolMode >= 1 && poolMode <= 6) return poolMode;
  if (assetId.includes("fire") || assetId.includes("charged-shot")) return 1;
  if (assetId.includes("water") || assetId.includes("tidal")) return 2;
  if (assetId.includes("earth") || assetId.includes("quake")) return 3;
  if (assetId.includes("air") || assetId.includes("gale")) return 4;
  if (assetId.includes("lightning") || assetId.includes("tempest")) return 5;
  if (assetId.includes("frost") || assetId.includes("glacial")) return 6;
  return 0;
}

const ELEMENT_GLSL_HELPERS = /* glsl */ `
  ${NOISE_GLSL}

  // Fast 2-octave FBM & single-step flow warp for crisp flame tongues & fast fragment shading
  float fxFbm3(vec2 p) {
    float v = 0.64 * fxNoise(p);
    p = p * 2.13 + vec2(13.1, 7.7);
    v += 0.36 * fxNoise(p);
    return v;
  }

  float fxRidge3(vec2 p) {
    return 1.0 - abs(2.0 * fxFbm3(p) - 1.0);
  }

  float fxFlameWarp(vec2 p, float t) {
    float qx = fxNoise(p * 1.4 + vec2(t * 0.6, -t * 1.3));
    float qy = fxNoise(p * 1.4 + vec2(4.1 - t * 0.5, -t * 1.1));
    return fxFbm3(p * 1.6 + (vec2(qx, qy) - 0.5) * 2.1 + vec2(0.0, -t * 1.4));
  }

  // Stylized blackbody flame color ramp (Draper cutoff -> crimson -> amber -> white-yellow core)
  vec3 blackbodyRamp(float heat) {
    float h = clamp(heat, 0.0, 1.0);
    vec3 soot = vec3(0.14, 0.10, 0.09);
    vec3 crimson = vec3(0.88, 0.16, 0.03);
    vec3 orange = vec3(1.18, 0.52, 0.08);
    vec3 whiteHot = vec3(1.65, 1.38, 0.72);
    vec3 col = mix(soot, crimson, smoothstep(0.05, 0.34, h));
    col = mix(col, orange, smoothstep(0.32, 0.68, h));
    col = mix(col, whiteHot, smoothstep(0.66, 0.96, h));
    return col;
  }
`;

const SHELL_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uElem;
  varying vec3 vNormalView;
  varying vec3 vLocalPos;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 pos = position;
    vec3 n = normalize(normal);
    if (uElem > 0.5 && uElem < 1.5) {
      // Fire: writhing flame comet lobes + trailing upward lick
      float w1 = sin(pos.x * 5.2 + uTime * 9.0) * cos(pos.y * 4.5 - uTime * 11.0);
      float w2 = sin(pos.z * 7.0 - uTime * 8.0) * 0.5;
      float lick = max(0.0, pos.y) * 0.42;
      pos += n * ((w1 + w2) * 0.16 + lick);
    } else if (uElem > 1.5 && uElem < 2.5) {
      // Water: capillary drop oscillation (low-mode surface tension lobes)
      float w = 0.09 * sin(dot(n, vec3(2.3, 3.1, 1.7)) * 2.4 + uTime * 7.5)
              + 0.06 * sin(dot(n, vec3(-3.7, 1.3, 2.9)) * 3.0 - uTime * 10.5);
      pos += n * w;
    } else if (uElem > 3.5 && uElem < 4.5) {
      // Air: spiraling cyclone shell ridges
      float ang = atan(n.z, n.x);
      float spiral = sin(ang * 4.0 + n.y * 5.5 - uTime * 12.0) * 0.08;
      pos += n * spiral;
    } else if (uElem > 4.5 && uElem < 5.5) {
      // Lightning: jagged high-frequency plasma crackle
      float j = sin(pos.x * 13.0 + uTime * 28.0) * cos(pos.y * 11.0 - uTime * 23.0) * 0.11;
      pos += n * j;
    } else if (uElem > 5.5) {
      // Frost: faceted crystalline protrusion
      float c = abs(sin(pos.x * 6.0) * cos(pos.z * 6.0)) * 0.18;
      pos += n * c;
    }
    vLocalPos = pos;
    vNormalView = normalize(normalMatrix * n);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const SHELL_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uPower;
  uniform float uReveal;
  uniform float uElem;
  uniform vec3 uColor;
  uniform vec3 uSecondary;
  varying vec3 vNormalView;
  varying vec3 vLocalPos;
  varying vec2 vUv;
  ${ELEMENT_GLSL_HELPERS}
  void main() {
    float fresnel = pow(prim_fresnel(vNormalView), 1.5);
    vec2 p = vec2(atan(vLocalPos.z, vLocalPos.x) * 0.65, vLocalPos.y * 1.4);

    if (uElem > 0.5 && uElem < 1.5) {
      // Fire head: boiling blackbody cells + flame-tongue cutout at top
      float warp = fxFlameWarp(p * 1.4, uTime * 1.2);
      float topErode = smoothstep(0.95, -0.55, vLocalPos.y + (warp - 0.5) * 0.9);
      float heat = clamp(warp * 0.72 + (1.0 - fresnel) * 0.42, 0.0, 1.0);
      vec3 col = blackbodyRamp(heat);
      float alpha = clamp(topErode * (0.45 + 0.55 * warp) * uPower * uReveal, 0.0, 0.96);
      if (alpha < 0.04) discard;
      gl_FragColor = vec4(col, alpha);
      return;
    }

    if (uElem > 1.5 && uElem < 2.5) {
      // Water head: swirling liquid refraction look + caustic veins + frothy seafoam rim
      float c1 = fxRidge3(p * 3.0 + vec2(uTime * 1.4, -uTime * 0.9));
      float c2 = fxRidge3(p * 4.5 + vec2(-uTime * 1.1, uTime * 1.3));
      float caust = pow(max(c1, c2), 3.0);
      float foam = smoothstep(0.62, 0.92, caust + fresnel * 0.55);
      vec3 deepWater = mix(vec3(0.04, 0.32, 0.72), uColor, 0.55);
      vec3 col = mix(deepWater, vec3(0.92, 0.98, 1.08), foam * 0.9 + caust * 0.35);
      float alpha = clamp((0.32 + 0.58 * fresnel + 0.35 * caust) * uReveal, 0.0, 0.92);
      gl_FragColor = vec4(col, alpha);
      return;
    }

    if (uElem > 3.5 && uElem < 4.5) {
      // Air head: transparent gale vortex ribbons (leaves center clear for rider silhouette)
      float ang = atan(vLocalPos.z, vLocalPos.x);
      float streak = smoothstep(0.25, 0.92, sin(ang * 3.0 + vLocalPos.y * 5.0 - uTime * 12.0));
      float n = fxFbm3(p * 2.5 - vec2(uTime * 1.6, 0.0));
      vec3 col = mix(uColor, uSecondary, streak * 0.75 + fresnel * 0.4);
      float alpha = clamp((0.08 + 0.52 * fresnel + 0.32 * streak * n) * uReveal, 0.0, 0.85);
      gl_FragColor = vec4(col, alpha);
      return;
    }

    if (uElem > 4.5 && uElem < 5.5) {
      // Lightning head: crackling electric filaments over plasma core
      float arc = pow(fxRidge3(p * 5.0 + vec2(floor(uTime * 20.0) * 1.3, uTime * 2.0)), 4.0);
      vec3 col = mix(uColor, vec3(1.5, 1.75, 2.2), clamp(arc + fresnel * 0.5, 0.0, 1.0));
      float alpha = clamp((0.25 + 0.7 * arc + 0.55 * fresnel) * uReveal, 0.0, 0.95);
      gl_FragColor = vec4(col, alpha);
      return;
    }

    if (uElem > 5.5) {
      // Frost head: faceted crystalline sheen + cold white rim
      float facet = fxRidge3(p * 4.2 + vec2(0.0, uTime * 0.35));
      vec3 col = mix(uColor, vec3(0.95, 0.99, 1.05), clamp(facet * 0.6 + fresnel * 0.65, 0.0, 1.0));
      float alpha = clamp((0.36 + 0.55 * fresnel + 0.25 * facet) * uReveal, 0.0, 0.92);
      gl_FragColor = vec4(col, alpha);
      return;
    }

    // Generic / arcane / mend fallback
    float warp = fxFbm3(vLocalPos.xy * 2.4 + vec2(vLocalPos.z * 1.5, uTime * 0.7));
    float band = smoothstep(0.28, 0.88, warp);
    vec3 col = mix(uColor, uSecondary, band * 0.65 + fresnel * 0.45);
    float alpha = clamp((0.24 + 0.68 * fresnel + 0.32 * band) * uPower * uReveal, 0.0, 0.92);
    gl_FragColor = vec4(col * (1.1 + fresnel * 0.7), alpha);
  }
`;

const SHIELD_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uLife;
  uniform float uReveal;
  uniform float uHexScale;
  uniform vec3 uColor;
  uniform vec3 uHitPos[8];
  uniform float uHitTime[8];
  varying vec3 vNormalView;
  varying vec3 vLocalPos;
  varying vec2 vUv;
  ${NOISE_GLSL}

  float hexDist(vec2 p) {
    p = abs(p);
    float c = dot(p, normalize(vec2(1.0, 1.7320508)));
    return max(c, p.x);
  }

  float hexEdge(vec2 uv, float scale) {
    vec2 r = vec2(1.0, 1.7320508);
    vec2 h = r * 0.5;
    vec2 p = uv * scale;
    vec2 a = mod(p, r) - h;
    vec2 b = mod(p - h, r) - h;
    vec2 gv = dot(a, a) < dot(b, b) ? a : b;
    float d = 0.5 - hexDist(gv);
    return 1.0 - smoothstep(0.02, 0.09, d);
  }

  void main() {
    float fresnel = pow(prim_fresnel(vNormalView), 1.4);
    float hex = hexEdge(vUv * vec2(2.4, 1.4), uHexScale);
    float noise = fxFbm(vUv * 5.0 + vec2(0.0, uTime * 0.35));

    float hitGlow = 0.0;
    vec3 nPos = normalize(vLocalPos);
    for (int i = 0; i < 8; i++) {
      float age = uTime - uHitTime[i];
      if (age >= 0.0 && age < 0.95) {
        float dist = distance(nPos, normalize(uHitPos[i]));
        float radius = age * 1.85;
        float ring = exp(-pow((dist - radius) * 7.5, 2.0)) * (1.0 - age / 0.95);
        hitGlow += ring;
      }
    }

    vec3 lowHpTint = vec3(1.0, 0.28, 0.18);
    vec3 baseCol = mix(lowHpTint, uColor, clamp(uLife, 0.0, 1.0));
    vec3 col = baseCol * (0.55 + 0.75 * fresnel + 0.65 * hex) + vec3(0.85, 0.95, 1.0) * hitGlow * 1.4;
    float alpha = clamp((0.18 + 0.55 * fresnel + 0.35 * hex + 0.15 * noise + hitGlow) * uReveal, 0.0, 0.92);
    gl_FragColor = vec4(col, alpha);
  }
`;

const RING_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RING_FRAGMENT_SHADER = /* glsl */ `
  uniform float uLife;
  uniform vec3 uColor;
  varying vec2 vUv;
  ${NOISE_GLSL}
  void main() {
    vec2 centered = (vUv - 0.5) * 2.0;
    float r = length(centered);
    float n = fxFbm(centered * 3.5 + vec2(uLife * 1.5, 0.0));
    float rim = smoothstep(0.35, 0.75, r) * (1.0 - smoothstep(0.82, 1.02, r));
    float alpha = rim * (1.0 - uLife) * (0.65 + 0.45 * n);
    gl_FragColor = vec4(uColor * (1.35 + n * 0.5), clamp(alpha, 0.0, 1.0));
  }
`;

// Billboarded elemental particle shader: renders flame tongues, caustic water splashes,
// faceted basalt rock chunks, swirling wind scythes, electric arcs & ice crystals (ZERO orbs).
const PARTICLE_VERTEX_SHADER = /* glsl */ `
  attribute vec4 aMeta; // x = life01, y = seed, z = elemMode, w = spinRad
  attribute vec3 aColor;
  varying vec2 vUv;
  varying vec4 vMeta;
  varying vec3 vColor;
  void main() {
    vUv = uv;
    vMeta = aMeta;
    vColor = aColor;
    vec4 mvCenter = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float sx = length((instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
    float sy = length((instanceMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    float c = cos(aMeta.w);
    float s = sin(aMeta.w);
    vec2 p = position.xy * vec2(sx, sy);
    mvCenter.xy += vec2(p.x * c - p.y * s, p.x * s + p.y * c);
    gl_Position = projectionMatrix * mvCenter;
  }
`;

const PARTICLE_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying vec4 vMeta;
  varying vec3 vColor;
  ${ELEMENT_GLSL_HELPERS}
  void main() {
    float life = vMeta.x;
    float seed = vMeta.y;
    float elem = vMeta.z;
    vec2 p = vUv * 2.0 - 1.0;
    float fadeEnv = smoothstep(0.0, 0.09, life) * (1.0 - smoothstep(0.55, 1.0, life));

    if (elem > 0.5 && elem < 1.5) {
      // Fire: stretched teardrop flame tongue distorted upward by domain-warped FBM
      float taper = mix(0.68, 0.16, smoothstep(-0.85, 0.9, p.y));
      vec2 q = vec2(p.x / taper, (p.y + 0.16) * 0.92);
      float warp = fxFlameWarp(vec2(q.x * 0.95, q.y * 0.85 + seed * 7.0), uTime * 1.2);
      float d = length(q) - (warp - 0.44) * 0.96;
      float mask = 1.0 - smoothstep(0.42, 0.92, d);
      if (mask < 0.03) discard;
      float heat = clamp((1.0 - d * 0.78) * (1.0 - life * 0.48) + (warp - 0.45) * 0.38, 0.0, 1.0);
      vec3 col = blackbodyRamp(heat);
      gl_FragColor = vec4(col, clamp(mask * fadeEnv * 0.96, 0.0, 1.0));
      return;
    }

    if (elem > 1.5 && elem < 2.5) {
      // Water: organic splash sheet with caustic veins + bubbly white seafoam
      float ang = atan(p.y, p.x);
      float lobe = fxFbm3(vec2(cos(ang) * 1.45 + seed * 11.0, sin(ang) * 1.45 - uTime * 2.4));
      float d = length(p) - (lobe - 0.44) * 0.88;
      float mask = 1.0 - smoothstep(0.38, 0.86, d);
      if (mask < 0.03) discard;
      float caust = pow(fxRidge3(vUv * 4.2 + vec2(uTime * 1.15 + seed * 5.0, -uTime * 0.9)), 2.8);
      float foam = smoothstep(0.48, 0.84, caust + (1.0 - mask) * 0.52 + lobe * 0.35);
      vec3 deep = vec3(0.05, 0.36, 0.78);
      vec3 aqua = mix(deep, vec3(0.18, 0.76, 1.02), clamp(mask + caust * 0.4, 0.0, 1.0));
      vec3 col = mix(aqua, vec3(0.95, 0.99, 1.06), foam * 0.88);
      gl_FragColor = vec4(col, clamp(mask * fadeEnv * 0.92, 0.0, 1.0));
      return;
    }

    if (elem > 2.5 && elem < 3.5) {
      // Earth: angular basalt rock chunk with glowing molten crack veins
      float poly = max(abs(p.x) * 0.88 + p.y * 0.48, max(abs(p.x * 0.62 - p.y * 0.82), -p.y * 0.9));
      float chip = (fxNoise(p * 3.5 + seed * 9.0) - 0.5) * 0.28;
      float mask = 1.0 - smoothstep(0.54, 0.64, poly + chip);
      if (mask < 0.04) discard;
      float crack = smoothstep(0.76, 0.93, fxRidge3(p * 3.1 + seed * 5.0));
      vec3 stone = vec3(0.24, 0.19, 0.15) * (0.75 + 0.45 * clamp(0.5 - p.y * 0.5, 0.0, 1.0));
      vec3 magma = mix(vColor, vec3(1.25, 0.55, 0.12), crack);
      vec3 col = mix(stone, magma, crack * 0.9);
      gl_FragColor = vec4(col, clamp(mask * fadeEnv, 0.0, 1.0));
      return;
    }

    if (elem > 3.5 && elem < 4.5) {
      // Air: curved cyclone crescent streak
      float r = length(p);
      float ang = atan(p.y, p.x);
      float arc = sin(ang + r * 3.2 - uTime * 5.5 + seed * 6.283);
      float band = exp(-pow((r - 0.52) * 3.8, 2.0)) * smoothstep(-0.15, 0.82, arc);
      float alpha = band * fadeEnv * 0.88;
      if (alpha < 0.03) discard;
      vec3 col = mix(vec3(0.62, 0.92, 1.02), vec3(1.08, 1.15, 1.22), band);
      gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
      return;
    }

    if (elem > 4.5 && elem < 5.5) {
      // Lightning: crackling jagged electric filament
      float stepT = floor(uTime * 22.0) * 0.7 + seed * 17.0;
      float zig = (fxNoise(vec2(p.y * 5.5, stepT)) - 0.5) * 0.62;
      float w = max(0.08, 0.85 - abs(p.y) * 0.55);
      float dist = abs(p.x - zig) / w;
      float core = exp(-dist * 5.5) * (1.0 - smoothstep(0.65, 1.0, abs(p.y)));
      float corona = exp(-dist * 1.9) * (1.0 - smoothstep(0.75, 1.0, abs(p.y)));
      float alpha = (core + corona * 0.55) * fadeEnv;
      if (alpha < 0.03) discard;
      vec3 col = mix(vec3(0.32, 0.58, 1.18), vec3(1.4, 1.65, 2.1), clamp(core * 1.3, 0.0, 1.0));
      gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
      return;
    }

    if (elem > 5.5) {
      // Frost: sharp 6-point ice crystal shard
      vec2 ap = abs(p);
      float hex = max(ap.x * 1.15 + ap.y * 0.5, ap.y * 1.05);
      float spire = max(ap.x * 2.1, ap.y * 0.72);
      float d = min(hex, spire);
      float mask = 1.0 - smoothstep(0.55, 0.72, d);
      if (mask < 0.03) discard;
      float glint = exp(-d * 3.5);
      vec3 col = mix(vec3(0.35, 0.82, 1.05), vec3(1.15, 1.25, 1.32), glint);
      gl_FragColor = vec4(col, clamp(mask * fadeEnv * 0.92, 0.0, 1.0));
      return;
    }

    // Generic / arcane / mend: 4-point astral sparkle
    vec2 ap = abs(p);
    float star = exp(-(ap.x * 3.5 + ap.y * 0.6)) + exp(-(ap.y * 3.5 + ap.x * 0.6));
    float core = exp(-dot(p, p) * 5.0);
    float alpha = clamp((star * 0.45 + core) * fadeEnv, 0.0, 1.0);
    if (alpha < 0.03) discard;
    gl_FragColor = vec4(vColor * (1.0 + core * 0.9), alpha);
  }
`;

// Elemental spline ribbon shader (crossed ground swath + rising elemental wall along curve).
const SPLINE_TRAIL_VERTEX = /* glsl */ `
  attribute float aKind; // 0 = ground swath, 1 = vertical curtain wall
  varying vec2 vUv;
  varying float vKind;
  void main() {
    vUv = uv;
    vKind = aKind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SPLINE_TRAIL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uProgress;
  uniform float uFade;
  uniform float uElem;
  uniform vec3 uColor;
  uniform vec3 uSecondary;
  varying vec2 vUv;
  varying float vKind;
  ${ELEMENT_GLSL_HELPERS}

  void main() {
    // Only reveal path behind or near the advancing spell head + soft head bloom
    float headMask = 1.0 - smoothstep(uProgress - 0.06, uProgress + 0.04, vUv.x);
    float headPulse = exp(-pow((vUv.x - uProgress) * 14.0, 2.0));
    float endSoft = smoothstep(0.0, 0.04, vUv.x) * (1.0 - smoothstep(0.95, 1.0, vUv.x));
    float gate = headMask * endSoft * uFade;
    if (gate < 0.015) discard;

    if (uElem > 0.5 && uElem < 1.5) {
      // FIRE (Blaze Path): glowing magma bed on ground + roaring blackbody flame wall above
      if (vKind < 0.5) {
        float across = abs(vUv.y - 0.5) * 2.0;
        float n = fxFlameWarp(vec2(vUv.x * 6.0, vUv.y * 2.2), uTime * 0.8);
        float bed = (1.0 - smoothstep(0.25, 0.98, across + (n - 0.5) * 0.45));
        float heat = clamp(bed * (0.45 + 0.55 * n + headPulse * 0.45), 0.0, 1.0);
        vec3 col = blackbodyRamp(heat);
        float a = clamp(bed * gate * 0.9, 0.0, 1.0);
        if (a < 0.02) discard;
        gl_FragColor = vec4(col, a);
        return;
      }
      // Vertical curtain wall of flickering flame tongues
      float y = vUv.y;
      float tongueHeight = 0.48 + 0.42 * fxFbm3(vec2(vUv.x * 8.5 - uTime * 0.4, uTime * 1.1));
      float warp = fxFlameWarp(vec2(vUv.x * 6.5, y * 1.7), uTime * 1.35);
      float flameMask = (1.0 - smoothstep(tongueHeight - 0.25, tongueHeight + 0.14, y + (warp - 0.5) * 0.45));
      float baseHeat = clamp((1.0 - y * 0.72) * 0.62 + warp * 0.55 + headPulse * 0.35, 0.0, 1.0);
      vec3 col = blackbodyRamp(baseHeat);
      float baseFade = smoothstep(0.02, 0.22, y + (warp - 0.5) * 0.16);
      float alpha = clamp(flameMask * baseFade * gate * 0.95, 0.0, 1.0);
      if (alpha < 0.02) discard;
      gl_FragColor = vec4(col, alpha);
      return;
    }

    if (uElem > 1.5 && uElem < 2.5) {
      // WATER (Tidal Surge): two-phase caustic wake on ground + foaming ocean surge crest above
      if (vKind < 0.5) {
        float across = abs(vUv.y - 0.5) * 2.0;
        float w1 = fxRidge3(vec2(vUv.x * 7.0 - uTime * 2.6, vUv.y * 3.5));
        float w2 = fxRidge3(vec2(vUv.x * 5.0 - uTime * 1.7, vUv.y * 4.2 + 2.3));
        float caust = pow(0.5 * (w1 + w2), 2.4);
        float edge = 1.0 - smoothstep(0.42, 0.98, across + (w1 - 0.5) * 0.28);
        float foam = smoothstep(0.45, 0.82, caust + headPulse * 0.65 + smoothstep(0.65, 0.95, across) * 0.35);
        vec3 col = mix(vec3(0.05, 0.42, 0.86), vec3(0.92, 0.98, 1.05), clamp(foam, 0.0, 1.0));
        float a = clamp(edge * gate * 0.88, 0.0, 1.0);
        if (a < 0.02) discard;
        gl_FragColor = vec4(col, a);
        return;
      }
      // Surging barrel wave wall with frothy white top crest
      float y = vUv.y;
      float crestH = 0.52 + 0.34 * sin(vUv.x * 16.0 - uTime * 6.5) * 0.5
                   + 0.28 * fxFbm3(vec2(vUv.x * 6.0 - uTime * 2.5, 1.3));
      float waveMask = 1.0 - smoothstep(crestH - 0.18, crestH + 0.08, y);
      float caust = pow(fxRidge3(vec2(vUv.x * 8.0 - uTime * 3.0, y * 4.5 + uTime * 1.2)), 2.2);
      float crestFoam = smoothstep(crestH - 0.22, crestH + 0.02, y);
      float headFoam = headPulse * smoothstep(0.1, 0.8, y + caust * 0.4);
      vec3 bodyCol = mix(vec3(0.04, 0.34, 0.78), vec3(0.18, 0.78, 1.02), caust * 0.75 + y * 0.35);
      vec3 col = mix(bodyCol, vec3(0.95, 0.99, 1.06), clamp(crestFoam * 0.92 + headFoam * 0.85, 0.0, 1.0));
      float a = clamp(waveMask * gate * 0.88, 0.0, 1.0);
      if (a < 0.02) discard;
      gl_FragColor = vec4(col, a);
      return;
    }

    if (uElem > 2.5 && uElem < 3.5) {
      // EARTH (Quake Line): shattered basalt trench with glowing molten fissure center
      if (vKind < 0.5) {
        float n = fxFbm3(vec2(vUv.x * 11.0, 2.7));
        float jitterCenter = (n - 0.5) * 0.35;
        float dist = abs((vUv.y - 0.5) - jitterCenter) * 2.0;
        float crackW = 0.24 + 0.14 * fxNoise(vec2(vUv.x * 18.0, 0.5));
        float rimW = 0.88;
        float innerCrack = 1.0 - smoothstep(crackW * 0.55, crackW, dist);
        float outerRock = (1.0 - smoothstep(rimW * 0.65, rimW, dist));
        float veins = pow(fxRidge3(vec2(vUv.x * 9.0, vUv.y * 5.0)), 4.0);
        vec3 basalt = vec3(0.20, 0.16, 0.13) + uSecondary * veins * 0.65;
        vec3 magma = mix(vec3(0.95, 0.38, 0.06), vec3(1.45, 0.95, 0.32), innerCrack);
        vec3 col = mix(basalt, magma, clamp(innerCrack * 0.95 + headPulse * 0.4, 0.0, 1.0));
        float a = clamp(outerRock * gate * 0.95, 0.0, 1.0);
        if (a < 0.02) discard;
        gl_FragColor = vec4(col, a);
        return;
      }
      // Subtle rising seismic dust haze above the crack
      float dust = fxFbm3(vec2(vUv.x * 7.0, vUv.y * 2.0 - uTime * 1.2));
      float a = (1.0 - vUv.y) * dust * gate * 0.42;
      if (a < 0.02) discard;
      gl_FragColor = vec4(mix(uColor, uSecondary, 0.3), a);
      return;
    }

    if (uElem > 3.5 && uElem < 4.5) {
      // AIR (Gale Sphere): sweeping translucent cyclone wind streams
      float stream = sin(vUv.x * 26.0 - uTime * 14.0 + vUv.y * 6.28318);
      float wisp = fxFbm3(vec2(vUv.x * 8.0 - uTime * 4.5, vUv.y * 3.0));
      float band = smoothstep(0.15, 0.9, stream * 0.5 + 0.5) * wisp;
      float edgeY = sin(vUv.y * 3.14159);
      float a = clamp(band * edgeY * gate * 0.78, 0.0, 1.0);
      if (a < 0.02) discard;
      vec3 col = mix(uColor, uSecondary, band * 0.8 + headPulse * 0.3);
      gl_FragColor = vec4(col, a);
      return;
    }

    if (uElem > 4.5 && uElem < 5.5) {
      // LIGHTNING (Tempest Arc): multi-octave crackling bolt filaments snapping along path
      float stepT = floor(uTime * 24.0) * 1.37;
      float zig1 = (fxNoise(vec2(vUv.x * 18.0, stepT)) - 0.5) * 0.42
                 + (fxNoise(vec2(vUv.x * 42.0, stepT + 7.1)) - 0.5) * 0.16;
      float zig2 = (fxNoise(vec2(vUv.x * 22.0, stepT + 19.3)) - 0.5) * 0.55;
      float d1 = abs((vUv.y - 0.5) - zig1);
      float d2 = abs((vUv.y - 0.5) - zig2);
      float bolt1 = exp(-d1 * 28.0);
      float bolt2 = exp(-d2 * 36.0) * 0.65;
      float corona = exp(-min(d1, d2) * 7.5) * 0.5;
      float energy = bolt1 + bolt2 + corona;
      float a = clamp(energy * gate, 0.0, 1.0);
      if (a < 0.02) discard;
      vec3 col = mix(vec3(0.32, 0.56, 1.18), vec3(1.5, 1.75, 2.2), clamp(bolt1 + bolt2, 0.0, 1.0));
      gl_FragColor = vec4(col, a);
      return;
    }

    // FROST (Glacial Spike) / default: icy rime crust + crystal lattice fractures
    float crystal = pow(fxRidge3(vec2(vUv.x * 10.0, vUv.y * 4.5)), 3.0);
    float acrossFade = vKind < 0.5 ? (1.0 - abs(vUv.y - 0.5) * 2.0) : (1.0 - vUv.y * 0.85);
    float a = clamp((0.35 + crystal * 0.75) * smoothstep(0.0, 0.35, acrossFade) * gate, 0.0, 0.92);
    if (a < 0.02) discard;
    vec3 col = mix(uColor, uSecondary, clamp(crystal * 0.85 + headPulse * 0.4, 0.0, 1.0));
    gl_FragColor = vec4(col, a);
  }
`;

// Ground-projected animated aiming ribbon & rotating sigil reticle (replaces sphere beads).
const PREVIEW_RIBBON_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PREVIEW_RIBBON_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  varying vec2 vUv;
  ${NOISE_GLSL}
  void main() {
    float across = abs(vUv.y - 0.5) * 2.0;
    float edgeRail = smoothstep(0.55, 0.82, across) * (1.0 - smoothstep(0.84, 1.0, across));
    float chevron = sin(vUv.x * 28.0 - uTime * 9.0 + across * 4.2);
    float flow = smoothstep(0.15, 0.85, chevron * 0.5 + 0.5) * (1.0 - smoothstep(0.45, 0.95, across));
    float softBody = (1.0 - across * across) * 0.28;
    float endFade = smoothstep(0.0, 0.05, vUv.x) * (1.0 - smoothstep(0.95, 1.0, vUv.x));
    float alpha = (edgeRail * 0.65 + flow * 0.62 + softBody) * endFade;
    if (alpha < 0.02) discard;
    vec3 col = mix(uColor, vec3(1.0, 1.0, 1.0), flow * 0.42 + edgeRail * 0.3);
    gl_FragColor = vec4(col * 1.15, clamp(alpha, 0.0, 0.92));
  }
`;

const SIGIL_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    float ang = atan(p.y, p.x);
    float outerRing = exp(-pow((r - 0.84) * 14.0, 2.0));
    float innerRing = exp(-pow((r - 0.52) * 18.0, 2.0));
    float ticks = smoothstep(0.4, 0.9, sin(ang * 8.0 + uTime * 3.0)) * exp(-pow((r - 0.68) * 11.0, 2.0));
    float cross = exp(-min(abs(p.x), abs(p.y)) * 22.0) * smoothstep(0.12, 0.45, r) * (1.0 - smoothstep(0.5, 0.88, r));
    float a = clamp(outerRing + innerRing * 0.85 + ticks * 0.75 + cross * 0.65, 0.0, 0.95);
    if (a < 0.02) discard;
    vec3 col = mix(uColor, vec3(1.0), (outerRing + innerRing) * 0.35);
    gl_FragColor = vec4(col * 1.2, a);
  }
`;

// Towering vertical Inferno Pillar shader (shoots straight up from under the target).
const FIRE_PILLAR_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vNormalView;
  void main() {
    vUv = uv;
    vec3 pos = position;
    float h = clamp(uv.y, 0.0, 1.0);
    float swirl = sin(uv.x * 18.849 + h * 7.0 - uTime * 9.0) * 0.16 * (0.3 + h);
    pos.x += normal.x * swirl;
    pos.z += normal.z * swirl;
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FIRE_PILLAR_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uReveal;
  varying vec2 vUv;
  varying vec3 vNormalView;
  ${ELEMENT_GLSL_HELPERS}
  void main() {
    float h = vUv.y;
    vec2 flowUv = vec2(vUv.x * 6.0 + sin(h * 5.0 - uTime * 3.0) * 0.22, h * 2.2);
    float warp = fxFlameWarp(flowUv, uTime * 2.1);
    float rib = 0.5 + 0.5 * sin(vUv.x * 37.699 + h * 8.0 - uTime * 8.5);
    float tongue = smoothstep(0.28, 0.78, warp * 0.75 + rib * 0.35 - h * 0.42);
    float baseFade = smoothstep(0.0, 0.14, h + (warp - 0.5) * 0.12);
    float fres = prim_fresnel(vNormalView);
    float sideFade = smoothstep(0.08, 0.44, 1.0 - fres);
    float topFade = smoothstep(0.0, 0.32, 1.0 - h);
    float tongueFade = smoothstep(0.22, 0.76, (1.0 - h * 0.62) + (warp - 0.5) * 0.62);
    float mask = tongue * baseFade * sideFade * topFade * tongueFade;
    if (mask < 0.04) discard;
    // Keep white-yellow hot only at the turbulent core & base; body stays saturated orange -> red -> soot
    float heat = clamp(warp * 0.85 + (1.0 - h) * 0.48 - fres * 0.45 - 0.18, 0.0, 1.0);
    vec3 col = blackbodyRamp(heat);
    gl_FragColor = vec4(col, clamp(mask * 0.96 * uReveal, 0.0, 0.96));
  }
`;

// Massive crashing Tidal Surge wave shader (caustic ocean wall + frothy rolling crest).
const TIDAL_WAVE_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vNormalView;
  void main() {
    vUv = uv;
    vec3 pos = position;
    float ripple = sin(uv.x * 12.0 - uTime * 6.0) * 0.12 + cos(uv.y * 9.0 - uTime * 8.0) * 0.08;
    pos += normal * ripple;
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const TIDAL_WAVE_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uReveal;
  uniform vec3 uColor;
  varying vec2 vUv;
  varying vec3 vNormalView;
  ${ELEMENT_GLSL_HELPERS}
  void main() {
    float y = vUv.y;
    float sideFade = sin(vUv.x * 3.14159);
    float c1 = fxRidge3(vec2(vUv.x * 6.0, y * 4.0 - uTime * 2.2));
    float c2 = fxRidge3(vec2(vUv.x * 9.0 + 1.7, y * 5.5 - uTime * 3.1));
    float caust = pow(0.5 * (c1 + c2), 2.3);
    float lipFoam = smoothstep(0.58, 0.94, y + (c1 - 0.5) * 0.24);
    float sprayFoam = smoothstep(0.55, 0.88, caust + pow(y, 1.6) * 0.45);
    float fres = pow(prim_fresnel(vNormalView), 1.35);
    vec3 deepOcean = mix(vec3(0.03, 0.28, 0.68), uColor, 0.55);
    vec3 turquoise = mix(deepOcean, vec3(0.18, 0.82, 1.04), clamp(caust * 0.8 + fres * 0.45, 0.0, 1.0));
    vec3 col = mix(turquoise, vec3(0.95, 0.99, 1.06), clamp(lipFoam * 0.95 + sprayFoam * 0.65, 0.0, 1.0));
    float alpha = clamp((0.62 + 0.35 * lipFoam + 0.22 * caust) * sideFade * uReveal, 0.0, 0.93);
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

// Absolute-Zero ground freeze disc shader.
const FROST_DISC_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uReveal;
  varying vec2 vUv;
  ${ELEMENT_GLSL_HELPERS}
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    float frac = pow(fxRidge3(p * 4.5 + vec2(0.0, 1.3)), 2.8);
    float rimNoise = fxFbm3(p * 5.0) * 0.22;
    float mask = 1.0 - smoothstep(0.72 - rimNoise, 0.98, r);
    if (mask < 0.02) discard;
    float rimFrost = smoothstep(0.55, 0.92, r + frac * 0.35);
    vec3 deepIce = vec3(0.18, 0.68, 0.98);
    vec3 frostWhite = vec3(0.92, 0.98, 1.06);
    vec3 col = mix(deepIce, frostWhite, clamp(frac * 0.85 + rimFrost * 0.65, 0.0, 1.0));
    gl_FragColor = vec4(col, clamp(mask * (0.48 + 0.42 * rimFrost + 0.25 * frac) * uReveal, 0.0, 0.92));
  }
`;

interface InstanceVisual {
  handle: number;
  anchor: THREE.Vector3;
  entityBigInt: bigint | null;
  detonated: boolean;
  rngState: number;
  emitCarry: number;
  elementMode: number;
  primaryColor: THREE.Color;
  secondaryColor: THREE.Color;
  hasCurveEmitter: boolean;
  hasPool: boolean;
  hasRingBurst: boolean;
  travelSeconds: number;
  curveRadius: number;
  curveSpread: number;
  curveSpeed: number;
  curveCount: number;
  poolCount: number;
  poolMode: number;
  ringCount: number;
  shellMesh?: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  shieldMesh?: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  hitCursor: number;
  splineRibbon?: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  spikes?: THREE.Mesh[];
  pillarMesh?: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  pillarRadius?: number;
  waveMesh?: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  freezeDisc?: THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial>;
  iceRingGroup?: THREE.Group;
}

interface RingSlot {
  active: boolean;
  age: number;
  duration: number;
  maxRadius: number;
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
}

function asColorHex(v: ParamValue | undefined, fallback: string): string {
  return typeof v === "string" && v.startsWith("#") ? v : fallback;
}

function asNumber(v: ParamValue | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function nextRand(state: { rngState: number }): number {
  let x = state.rngState | 0;
  if (x === 0) x = 0x9e3779b9 | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.rngState = x;
  return ((x >>> 0) % 100000) / 100000;
}

/** Build crossed ground-swath + rising vertical curtain ribbon geometry along waypoints. */
function buildSplineRibbonGeometry(waypoints: readonly [number, number, number][], elem: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (const wp of waypoints) {
    pts.push(new THREE.Vector3(wp[0], wp[1] + 0.08, wp[2]));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const segs = SPLINE_LINE_SAMPLES;
  const cols = segs + 1;
  // Two strips per spline (ground swath + vertical curtain), each cols * 2 vertices
  const vertCount = cols * 4;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const kinds = new Float32Array(vertCount);
  const indices: number[] = [];

  const groundHalfW = elem === 3 ? 0.92 : elem === 2 ? 0.85 : 0.74;
  const curtainH = elem === 1 ? 1.55 : elem === 2 ? 1.25 : elem === 5 ? 1.15 : elem === 4 ? 1.3 : 0.85;

  const p = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const side = new THREE.Vector3();

  for (let i = 0; i < cols; i++) {
    const u = i / segs;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, tan);
    side.set(-tan.z, 0, tan.x);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    else side.normalize();

    // Strip 0: Ground swath (left, right)
    const gBase = i * 2;
    positions[gBase * 3] = p.x - side.x * groundHalfW;
    positions[gBase * 3 + 1] = p.y;
    positions[gBase * 3 + 2] = p.z - side.z * groundHalfW;
    uvs[gBase * 2] = u;
    uvs[gBase * 2 + 1] = 0;
    kinds[gBase] = 0;

    positions[(gBase + 1) * 3] = p.x + side.x * groundHalfW;
    positions[(gBase + 1) * 3 + 1] = p.y;
    positions[(gBase + 1) * 3 + 2] = p.z + side.z * groundHalfW;
    uvs[(gBase + 1) * 2] = u;
    uvs[(gBase + 1) * 2 + 1] = 1;
    kinds[gBase + 1] = 0;

    // Strip 1: Vertical elemental curtain (bottom, top)
    const cOffset = cols * 2;
    const cBase = cOffset + i * 2;
    positions[cBase * 3] = p.x;
    positions[cBase * 3 + 1] = p.y - 0.04;
    positions[cBase * 3 + 2] = p.z;
    uvs[cBase * 2] = u;
    uvs[cBase * 2 + 1] = 0;
    kinds[cBase] = 1;

    positions[(cBase + 1) * 3] = p.x;
    positions[(cBase + 1) * 3 + 1] = p.y + curtainH;
    positions[(cBase + 1) * 3 + 2] = p.z;
    uvs[(cBase + 1) * 2] = u;
    uvs[(cBase + 1) * 2 + 1] = 1;
    kinds[cBase + 1] = 1;
  }

  for (let strip = 0; strip < 2; strip++) {
    const off = strip * cols * 2;
    for (let i = 0; i < segs; i++) {
      const a = off + i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("aKind", new THREE.BufferAttribute(kinds, 1));
  geo.setIndex(indices);
  return geo;
}

/** Build a sculpted 3D forward-curling ocean wave crest geometry (local +Z forward). */
function buildTidalWaveGeometry(width = 6.2, height = 3.8): THREE.BufferGeometry {
  const segX = 20;
  const segY = 12;
  const cols = segX + 1;
  const rows = segY + 1;
  const positions = new Float32Array(cols * rows * 3);
  const normals = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  const indices: number[] = [];

  for (let iy = 0; iy < rows; iy++) {
    const v = iy / segY;
    // Curve upward cleanly, then arch forward (+Z) at top like a curling barrel wave crest
    const archH = Math.sin(v * Math.PI * 0.62) * height;
    const zCurl = (v < 0.6 ? -0.9 + v * 1.8 : 0.18 + Math.sin((v - 0.6) * 3.8) * 1.35);
    const widthTaper = 1.0 - 0.14 * v;
    for (let ix = 0; ix < cols; ix++) {
      const u = ix / segX;
      const x = (u - 0.5) * width * widthTaper;
      const bowZ = zCurl - (u - 0.5) * (u - 0.5) * 1.4;
      const idx = iy * cols + ix;
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = archH;
      positions[idx * 3 + 2] = bowZ;
      normals[idx * 3] = 0;
      normals[idx * 3 + 1] = v > 0.7 ? -0.3 : 0.45;
      normals[idx * 3 + 2] = 0.85;
      uvs[idx * 2] = u;
      uvs[idx * 2 + 1] = v;
    }
  }
  for (let iy = 0; iy < segY; iy++) {
    for (let ix = 0; ix < segX; ix++) {
      const a = iy * cols + ix;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Client Three.js renderer for ManagedEffectRuntime (@mmo-engine/render-fx):
 * renders billboarded elemental GLSL particles (flame tongues, caustic water
 * splashes, fractured rock shards, wind scythes, electric arcs & ice crystals),
 * crossed ground + vertical elemental spline ribbons, faceted rock/frost spikes,
 * hex Force Shields with hit-ring ripples, RingBurst shockwaves, and an animated
 * ground-projected spline aim ribbon with rotating arcane sigil reticle.
 */
export class SpellFxLayer {
  readonly group = new THREE.Group();
  readonly runtime: ManagedEffectRuntime;

  private readonly sphereGeo = new THREE.SphereGeometry(1, 32, 22);
  private readonly ringGeo = new THREE.RingGeometry(0.45, 1.0, 40);
  private readonly spikeGeo = new THREE.ConeGeometry(0.28, 1.45, 5);
  private readonly pillarGeo = new THREE.CylinderGeometry(0.32, 1.05, 7.6, 24, 12, true);
  private readonly waveGeo = buildTidalWaveGeometry();
  private readonly discGeo = new THREE.CircleGeometry(3.8, 36);
  private readonly particleGeo = new THREE.PlaneGeometry(1, 1);
  private readonly pMetaArray = new Float32Array(MAX_PARTICLES * 4);
  private readonly pColorArray = new Float32Array(MAX_PARTICLES * 3);
  private readonly pMetaAttr: THREE.InstancedBufferAttribute;
  private readonly pColorAttr: THREE.InstancedBufferAttribute;
  private readonly particleMat = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERTEX_SHADER,
    fragmentShader: PARTICLE_FRAGMENT_SHADER,
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  private readonly particles: THREE.InstancedMesh;

  private readonly pActive = new Uint8Array(MAX_PARTICLES);
  private readonly pPx = new Float32Array(MAX_PARTICLES);
  private readonly pPy = new Float32Array(MAX_PARTICLES);
  private readonly pPz = new Float32Array(MAX_PARTICLES);
  private readonly pVx = new Float32Array(MAX_PARTICLES);
  private readonly pVy = new Float32Array(MAX_PARTICLES);
  private readonly pVz = new Float32Array(MAX_PARTICLES);
  private readonly pAge = new Float32Array(MAX_PARTICLES);
  private readonly pMaxAge = new Float32Array(MAX_PARTICLES);
  private readonly pSize = new Float32Array(MAX_PARTICLES);
  private readonly pSeed = new Float32Array(MAX_PARTICLES);
  private readonly pSpin = new Float32Array(MAX_PARTICLES);
  private readonly pSpinVel = new Float32Array(MAX_PARTICLES);
  private readonly pR = new Float32Array(MAX_PARTICLES);
  private readonly pG = new Float32Array(MAX_PARTICLES);
  private readonly pB = new Float32Array(MAX_PARTICLES);
  private readonly pMode = new Uint8Array(MAX_PARTICLES);
  private pCursor = 0;

  private readonly ringPool: RingSlot[] = [];
  private readonly visuals = new Map<number, InstanceVisual>();

  // Zero-alloc triangle-strip ground aiming ribbon + sigil target reticle (no round beads)
  private readonly previewPositions = new Float32Array(PREVIEW_SAMPLES * 2 * 3);
  private readonly previewGeo = new THREE.BufferGeometry();
  private readonly previewMat = new THREE.ShaderMaterial({
    vertexShader: PREVIEW_RIBBON_VERTEX,
    fragmentShader: PREVIEW_RIBBON_FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0xff6622) },
    },
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private readonly previewMesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly previewEndpointGeo = new THREE.PlaneGeometry(2.6, 2.6);
  private readonly previewEndpointMat = new THREE.ShaderMaterial({
    vertexShader: PREVIEW_RIBBON_VERTEX,
    fragmentShader: SIGIL_FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0xff6622) },
    },
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private readonly previewEndpointMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

  // Reusable scratch buffers to maintain zero per-frame allocations in update().
  private readonly _obj = new THREE.Object3D();
  private readonly _vec = new THREE.Vector3();
  private readonly _samplePos: [number, number, number] = [0, 0, 0];
  private readonly _sampleTan: [number, number, number] = [0, 0, 1];
  private activeParticleRenderCount = 0;
  private elapsedTime = 0;

  constructor(
    defs: readonly EffectDefinition[],
    fxSlots?: Record<string, Partial<Record<FxTier, number>>>,
    tier: FxTier = "high",
  ) {
    this.group.name = "spell-fx-layer";

    this.pMetaAttr = new THREE.InstancedBufferAttribute(this.pMetaArray, 4);
    this.pMetaAttr.setUsage(THREE.DynamicDrawUsage);
    this.pColorAttr = new THREE.InstancedBufferAttribute(this.pColorArray, 3);
    this.pColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.particleGeo.setAttribute("aMeta", this.pMetaAttr);
    this.particleGeo.setAttribute("aColor", this.pColorAttr);

    this.particles = new THREE.InstancedMesh(this.particleGeo, this.particleMat, MAX_PARTICLES);
    this.particles.name = "spell-fx-particles";
    this.particles.frustumCulled = false;
    this.particles.count = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this._obj.position.set(0, -999, 0);
      this._obj.scale.setScalar(0.001);
      this._obj.updateMatrix();
      this.particles.setMatrixAt(i, this._obj.matrix);
    }
    this.particles.instanceMatrix.needsUpdate = true;
    this.group.add(this.particles);

    for (let i = 0; i < RING_POOL_SIZE; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: RING_VERTEX_SHADER,
        fragmentShader: RING_FRAGMENT_SHADER,
        uniforms: {
          uLife: { value: 0 },
          uColor: { value: new THREE.Color(0xff5522) },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      this.group.add(mesh);
      this.ringPool.push({ active: false, age: 0, duration: 0.6, maxRadius: 2.5, mesh });
    }

    const previewUvs = new Float32Array(PREVIEW_SAMPLES * 2 * 2);
    const previewIndices: number[] = [];
    for (let i = 0; i < PREVIEW_SAMPLES; i++) {
      const u = i / (PREVIEW_SAMPLES - 1);
      previewUvs[i * 4] = u;
      previewUvs[i * 4 + 1] = 0;
      previewUvs[i * 4 + 2] = u;
      previewUvs[i * 4 + 3] = 1;
      if (i < PREVIEW_SAMPLES - 1) {
        const a = i * 2;
        previewIndices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.previewGeo.setAttribute("position", new THREE.BufferAttribute(this.previewPositions, 3));
    this.previewGeo.setAttribute("uv", new THREE.BufferAttribute(previewUvs, 2));
    this.previewGeo.setIndex(previewIndices);
    this.previewGeo.setDrawRange(0, 0);

    this.previewMesh = new THREE.Mesh(this.previewGeo, this.previewMat);
    this.previewMesh.name = "spline-cast-preview";
    this.previewMesh.visible = false;
    this.previewMesh.frustumCulled = false;
    this.group.add(this.previewMesh);

    this.previewEndpointMesh = new THREE.Mesh(this.previewEndpointGeo, this.previewEndpointMat);
    this.previewEndpointMesh.rotation.x = -Math.PI / 2;
    this.previewEndpointMesh.visible = false;
    this.group.add(this.previewEndpointMesh);

    const hooks: EffectRendererHooks = {
      onSpawn: (inst) => this.handleSpawn(inst),
      onParam: (inst) => this.syncColorsAndUniforms(inst),
      onPhase: (inst, phase) => this.handlePhase(inst, phase),
      onRebind: (inst) => this.handleRebind(inst),
      onHit: (inst, hit) => this.handleHit(inst, hit),
      onInterrupt: (inst) => this.handleInterrupt(inst),
      onUpdate: (inst, dt) => this.handleInstanceUpdate(inst, dt),
      onDispose: (inst) => this.handleDispose(inst),
    };

    this.runtime = createEffectRuntime({
      initialTier: tier,
      fxSlots,
      hooks,
    });
    for (const def of defs) {
      this.runtime.registerAsset(def);
    }
  }

  get activeInstanceCount(): number {
    return this.visuals.size;
  }

  get activeParticleCount(): number {
    return this.activeParticleRenderCount;
  }

  get isPreviewVisible(): boolean {
    return this.previewMesh.visible;
  }

  setQuality(tier: FxTier): void {
    this.runtime.setQuality(tier);
  }

  applyFxMessage(msg: FxMessage, clientTick: number, tickHz = 30): number | null {
    return this.runtime.applyFxMessage(msg as FxWireMessage, clientTick, tickHz);
  }

  setPreview(waypoints: readonly [number, number, number][], colorHex = "#ff6622"): void {
    if (waypoints.length < 2) {
      this.clearPreview();
      return;
    }
    this.previewMat.uniforms.uColor!.value.set(colorHex);
    this.previewEndpointMat.uniforms.uColor!.value.set(colorHex);

    for (let i = 0; i < PREVIEW_SAMPLES; i++) {
      const t = i / (PREVIEW_SAMPLES - 1);
      sampleSpline(waypoints, t, this._samplePos, this._sampleTan);
      const tx = this._sampleTan[0];
      const tz = this._sampleTan[2];
      const len = Math.hypot(tx, tz) || 1;
      const nx = -tz / len;
      const nz = tx / len;
      const y = this._samplePos[1] + 0.14;
      const base = i * 6;
      this.previewPositions[base] = this._samplePos[0] - nx * PREVIEW_HALF_WIDTH_M;
      this.previewPositions[base + 1] = y;
      this.previewPositions[base + 2] = this._samplePos[2] - nz * PREVIEW_HALF_WIDTH_M;
      this.previewPositions[base + 3] = this._samplePos[0] + nx * PREVIEW_HALF_WIDTH_M;
      this.previewPositions[base + 4] = y;
      this.previewPositions[base + 5] = this._samplePos[2] + nz * PREVIEW_HALF_WIDTH_M;
    }
    const attr = this.previewGeo.getAttribute("position") as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.previewGeo.setDrawRange(0, (PREVIEW_SAMPLES - 1) * 6);
    this.previewMesh.visible = true;

    const end = waypoints[waypoints.length - 1]!;
    this.previewEndpointMesh.position.set(end[0], end[1] + 0.16, end[2]);
    this.previewEndpointMesh.visible = true;
  }

  clearPreview(): void {
    this.previewMesh.visible = false;
    this.previewEndpointMesh.visible = false;
    this.previewGeo.setDrawRange(0, 0);
  }

  update(dt: number, camera: THREE.Camera | unknown, resolveEntityPos?: EntityPositionResolver): void {
    if (dt <= 0) return;
    this.elapsedTime += dt;
    this.particleMat.uniforms.uTime!.value = this.elapsedTime;
    this.previewMat.uniforms.uTime!.value = this.elapsedTime;
    this.previewEndpointMat.uniforms.uTime!.value = this.elapsedTime;

    if (resolveEntityPos) {
      for (const vis of this.visuals.values()) {
        if (vis.entityBigInt !== null && resolveEntityPos(vis.entityBigInt, this._vec)) {
          vis.anchor.copy(this._vec);
        }
      }
    }

    this.runtime.update(dt, camera);
    this.updateParticles(dt);
    this.updateRings(dt);
  }

  dispose(): void {
    this.runtime.dispose();
    for (const slot of this.ringPool) {
      this.group.remove(slot.mesh);
      slot.mesh.material.dispose();
    }
    this.ringPool.length = 0;
    this.group.remove(this.particles);
    this.particleGeo.dispose();
    this.particleMat.dispose();
    this.sphereGeo.dispose();
    this.ringGeo.dispose();
    this.spikeGeo.dispose();
    this.pillarGeo.dispose();
    this.waveGeo.dispose();
    this.discGeo.dispose();
    this.previewGeo.dispose();
    this.previewMat.dispose();
    this.previewEndpointGeo.dispose();
    this.previewEndpointMat.dispose();
  }

  private handleSpawn(inst: Readonly<LiveEffectState>): void {
    const primaryHex = asColorHex(
      inst.params.bodyColor ?? inst.params.color,
      "#ff5522",
    );
    const secondaryHex = asColorHex(inst.params.secondaryColor, "#ffd166");

    let hasCurveEmitter = false;
    let hasPool = false;
    let hasRingBurst = false;
    let hasShell = false;
    let hasShield = false;
    let curveRadius = 0.45;
    let curveSpread = 0.4;
    let curveSpeed = 16;
    let curveCount = 100;
    let poolCount = 120;
    let poolMode = 0;
    let ringCount = 2;
    let shellPower = 1.4;
    let hexScale = 3.0;

    for (let i = 0; i < inst.def.modules.length; i++) {
      const mod = inst.def.modules[i]!;
      const mp = inst.moduleParams[i] ?? {};
      if (mod.module === "CurveEmitterModule") {
        hasCurveEmitter = true;
        curveRadius = asNumber(mp.radius, curveRadius);
        curveSpread = asNumber(mp.spread, curveSpread);
        curveSpeed = asNumber(mp.speed, curveSpeed);
        curveCount = asNumber(mp.count, curveCount);
      } else if (mod.module === "PoolModule") {
        hasPool = true;
        poolCount = asNumber(mp.count, poolCount);
        poolMode = asNumber(mp.mode, poolMode);
      } else if (mod.module === "RingBurstModule") {
        hasRingBurst = true;
        ringCount = asNumber(mp.count, ringCount);
      } else if (mod.module === "ShellModule") {
        hasShell = true;
        shellPower = asNumber(mp.power, shellPower);
      } else if (mod.module === "ShieldModule") {
        hasShield = true;
        hexScale = asNumber(mp.hexScale, hexScale);
      }
    }

    const elementMode = resolveElementMode(inst.def.assetId, poolMode);

    const vis: InstanceVisual = {
      handle: inst.handle,
      anchor: new THREE.Vector3(),
      entityBigInt: parseEntityId(inst.binding.entityId),
      detonated: false,
      rngState: (inst.seed | 0) || 1337,
      emitCarry: 0,
      elementMode,
      primaryColor: new THREE.Color(primaryHex),
      secondaryColor: new THREE.Color(secondaryHex),
      hasCurveEmitter,
      hasPool,
      hasRingBurst,
      travelSeconds: asNumber(inst.params.travelSeconds, 0.55),
      curveRadius,
      curveSpread,
      curveSpeed,
      curveCount,
      poolCount,
      poolMode: elementMode,
      ringCount,
      hitCursor: 0,
    };

    if (inst.binding.pos) {
      vis.anchor.set(inst.binding.pos[0], inst.binding.pos[1], inst.binding.pos[2]);
    } else if (inst.binding.waypoints && inst.binding.waypoints.length > 0) {
      const p0 = inst.binding.waypoints[0]!;
      vis.anchor.set(p0[0], p0[1], p0[2]);
    }

    if (hasShell && (inst.binding.kind !== "spline" || elementMode === 4)) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: SHELL_VERTEX_SHADER,
        fragmentShader: SHELL_FRAGMENT_SHADER,
        uniforms: {
          uTime: { value: inst.age },
          uPower: { value: shellPower },
          uReveal: { value: 1 },
          uElem: { value: elementMode },
          uColor: { value: vis.primaryColor.clone() },
          uSecondary: { value: vis.secondaryColor.clone() },
        },
        transparent: true,
        side: THREE.DoubleSide,
        blending: elementMode === 1 || elementMode === 2 ? THREE.NormalBlending : THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.sphereGeo, mat);
      mesh.position.copy(vis.anchor);
      mesh.scale.setScalar(elementMode === 4 ? 0.95 : 0.72);
      this.group.add(mesh);
      vis.shellMesh = mesh;
    }

    if (hasShield) {
      const hitPos: THREE.Vector3[] = [];
      for (let i = 0; i < HIT_SLOTS; i++) hitPos.push(new THREE.Vector3(0, 1, 0));
      const hitTime = new Float32Array(HIT_SLOTS);
      hitTime.fill(-100);

      const mat = new THREE.ShaderMaterial({
        vertexShader: SHELL_VERTEX_SHADER,
        fragmentShader: SHIELD_FRAGMENT_SHADER,
        uniforms: {
          uTime: { value: inst.age },
          uLife: { value: asNumber(inst.params.hp01, 1) },
          uReveal: { value: 1 },
          uElem: { value: 0 },
          uHexScale: { value: hexScale },
          uColor: { value: vis.primaryColor.clone() },
          uHitPos: { value: hitPos },
          uHitTime: { value: hitTime },
        },
        transparent: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.sphereGeo, mat);
      mesh.position.copy(vis.anchor).add(new THREE.Vector3(0, 1.0, 0));
      mesh.scale.setScalar(1.35);
      this.group.add(mesh);
      vis.shieldMesh = mesh;
    }

    if (inst.binding.kind === "spline" && inst.binding.waypoints && inst.binding.waypoints.length >= 2) {
      const ribbonGeo = buildSplineRibbonGeometry(inst.binding.waypoints, elementMode);
      const ribbonMat = new THREE.ShaderMaterial({
        vertexShader: SPLINE_TRAIL_VERTEX,
        fragmentShader: SPLINE_TRAIL_FRAGMENT,
        uniforms: {
          uTime: { value: inst.age },
          uProgress: { value: 0.08 },
          uFade: { value: 1 },
          uElem: { value: elementMode },
          uColor: { value: vis.primaryColor.clone() },
          uSecondary: { value: vis.secondaryColor.clone() },
        },
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.NormalBlending,
      });
      const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
      ribbon.frustumCulled = false;
      this.group.add(ribbon);
      vis.splineRibbon = ribbon;

      // Fire: towering vertical Inferno Pillar shooting straight up (radius >= 2x target radius)
      if (elementMode === 1) {
        const radiusM = Math.max(1.8, Math.min(2.6, asNumber(inst.params.radiusM, 3.2) * 0.68));
        vis.pillarRadius = radiusM;
        const pillarMat = new THREE.ShaderMaterial({
          vertexShader: FIRE_PILLAR_VERTEX_SHADER,
          fragmentShader: FIRE_PILLAR_FRAGMENT_SHADER,
          uniforms: { uTime: { value: inst.age }, uReveal: { value: 1 } },
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.NormalBlending,
        });
        const outerPillar = new THREE.Mesh(this.pillarGeo, pillarMat);
        const endWp = inst.binding.waypoints[inst.binding.waypoints.length - 1]!;
        outerPillar.position.set(endWp[0], endWp[1] + 3.65, endWp[2]);
        outerPillar.scale.set(radiusM, 0.25, radiusM);
        outerPillar.frustumCulled = false;
        this.group.add(outerPillar);
        vis.pillarMesh = outerPillar;
      }

      // Water (Tidal Surge): massive 3D forward-curling wave crest sweeping the spline
      if (elementMode === 2) {
        const waveMat = new THREE.ShaderMaterial({
          vertexShader: TIDAL_WAVE_VERTEX_SHADER,
          fragmentShader: TIDAL_WAVE_FRAGMENT_SHADER,
          uniforms: {
            uTime: { value: inst.age },
            uReveal: { value: 1 },
            uColor: { value: vis.primaryColor.clone() },
          },
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.NormalBlending,
        });
        const wave = new THREE.Mesh(this.waveGeo, waveMat);
        wave.frustumCulled = false;
        this.group.add(wave);
        vis.waveMesh = wave;
      }

      // Frost (Glacial Spike): Absolute-Zero frosted ground freeze disc at detonation
      if (elementMode === 6) {
        const endWp = inst.binding.waypoints[inst.binding.waypoints.length - 1]!;
        const frostMat = new THREE.ShaderMaterial({
          vertexShader: PREVIEW_RIBBON_VERTEX,
          fragmentShader: FROST_DISC_FRAGMENT_SHADER,
          uniforms: { uTime: { value: inst.age }, uReveal: { value: 1 } },
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.NormalBlending,
        });
        const disc = new THREE.Mesh(this.discGeo, frostMat);
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(endWp[0], endWp[1] + 0.1, endWp[2]);
        disc.scale.setScalar(0.2);
        this.group.add(disc);
        vis.freezeDisc = disc;
      }

      // Erupting 3D stone pillars (Earth) or translucent crystal spires (Frost) along the spline
      if (elementMode === 3 || elementMode === 6) {
        vis.spikes = [];
        for (let s = 0; s < SPLINE_SPIKE_COUNT; s++) {
          const t = (s + 0.5) / SPLINE_SPIKE_COUNT;
          sampleSpline(inst.binding.waypoints, t, this._samplePos, this._sampleTan);
          const spikeMat = new THREE.MeshStandardMaterial({
            color: elementMode === 6 ? 0x99e9ff : 0x5c4738,
            emissive: elementMode === 6 ? 0x1d70a8 : 0x6b2808,
            emissiveIntensity: elementMode === 6 ? 0.55 : 0.45,
            roughness: elementMode === 6 ? 0.18 : 0.88,
            metalness: elementMode === 6 ? 0.15 : 0.05,
            transparent: elementMode === 6,
            opacity: elementMode === 6 ? 0.85 : 1.0,
          });
          const spike = new THREE.Mesh(this.spikeGeo, spikeMat);
          spike.position.set(
            this._samplePos[0] + (nextRand(vis) - 0.5) * 0.6,
            this._samplePos[1] - 0.8,
            this._samplePos[2] + (nextRand(vis) - 0.5) * 0.6,
          );
          spike.rotation.set(
            (nextRand(vis) - 0.5) * 0.45,
            nextRand(vis) * Math.PI * 2,
            (nextRand(vis) - 0.5) * 0.45,
          );
          const wScale = (elementMode === 6 ? 0.92 : 0.75) + nextRand(vis) * 0.65;
          const hScale = (elementMode === 6 ? 1.25 : 0.85) + nextRand(vis) * 0.95;
          spike.scale.set(wScale, hScale, wScale);
          spike.userData = { t, baseY: this._samplePos[1], targetH: hScale };
          this.group.add(spike);
          vis.spikes.push(spike);
        }
      }
    }

    this.visuals.set(inst.handle, vis);

    // Destructible circular Ice Ring Prison (12 crystal prisms around trapped target)
    if (inst.def.assetId === "fx.ice-ring") {
      const r = asNumber(inst.params.radius, 1.5);
      const ringGrp = new THREE.Group();
      ringGrp.position.copy(vis.anchor);
      const count = 12;
      for (let i = 0; i < count; i++) {
        const ang = (i / count) * Math.PI * 2;
        const shardMat = new THREE.MeshStandardMaterial({
          color: 0xa5f3fc,
          emissive: 0x0ea5e9,
          emissiveIntensity: 0.65,
          roughness: 0.14,
          metalness: 0.15,
          transparent: true,
          opacity: 0.86,
        });
        const shard = new THREE.Mesh(this.spikeGeo, shardMat);
        shard.position.set(Math.cos(ang) * r, 0.72, Math.sin(ang) * r);
        shard.rotation.y = -ang;
        shard.rotation.z = -0.22;
        shard.scale.set(0.95, 1.25, 0.95);
        ringGrp.add(shard);
      }
      this.group.add(ringGrp);
      vis.iceRingGroup = ringGrp;
    }

    if (inst.binding.kind !== "spline" && hasPool && !hasCurveEmitter) {
      const burstCount = Math.min(48, Math.max(12, Math.floor(poolCount * 0.25)));
      this.emitBurst(vis, vis.anchor.x, vis.anchor.y + 0.9, vis.anchor.z, burstCount);
    }
    if (inst.binding.kind !== "spline" && hasRingBurst && inst.phase === "impact") {
      this.triggerRing(vis.anchor.x, vis.anchor.y + 0.15, vis.anchor.z, vis.primaryColor, 2.8);
    }
  }

  private handleRebind(inst: Readonly<LiveEffectState>): void {
    const vis = this.visuals.get(inst.handle);
    if (!vis) return;
    vis.entityBigInt = parseEntityId(inst.binding.entityId);
    if (inst.binding.pos) {
      vis.anchor.set(inst.binding.pos[0], inst.binding.pos[1], inst.binding.pos[2]);
    }
  }

  private handlePhase(inst: Readonly<LiveEffectState>, phase: string): void {
    const vis = this.visuals.get(inst.handle);
    if (!vis) return;
    if (phase === "impact" && !vis.detonated) {
      this.detonateSplineOrEndpoint(inst, vis);
    }
  }

  private handleHit(
    inst: Readonly<LiveEffectState>,
    hit: { pos: [number, number, number]; normal?: [number, number, number] },
  ): void {
    const vis = this.visuals.get(inst.handle);
    if (!vis?.shieldMesh) return;
    const slot = vis.hitCursor % HIT_SLOTS;
    vis.hitCursor++;
    const uniforms = vis.shieldMesh.material.uniforms;
    const hitArr = uniforms.uHitPos!.value as THREE.Vector3[];
    const timeArr = uniforms.uHitTime!.value as Float32Array;
    const slotVec = hitArr[slot];
    if (slotVec) {
      slotVec.set(hit.pos[0], hit.pos[1], hit.pos[2]);
      if (slotVec.lengthSq() < 1e-4) slotVec.set(0, 0, 1);
    }
    timeArr[slot] = inst.age;
  }

  private handleInterrupt(inst: Readonly<LiveEffectState>): void {
    const vis = this.visuals.get(inst.handle);
    if (!vis) return;
    if (inst.fadeDuration <= 0) {
      this.handleDispose(inst);
    }
  }

  private syncColorsAndUniforms(inst: Readonly<LiveEffectState>): void {
    const vis = this.visuals.get(inst.handle);
    if (!vis) return;
    vis.primaryColor.set(asColorHex(inst.params.bodyColor ?? inst.params.color, "#ff5522"));
    vis.secondaryColor.set(asColorHex(inst.params.secondaryColor, "#ffd166"));
    if (vis.shellMesh) {
      vis.shellMesh.material.uniforms.uColor!.value.copy(vis.primaryColor);
      vis.shellMesh.material.uniforms.uSecondary!.value.copy(vis.secondaryColor);
    }
    if (vis.splineRibbon) {
      vis.splineRibbon.material.uniforms.uColor!.value.copy(vis.primaryColor);
      vis.splineRibbon.material.uniforms.uSecondary!.value.copy(vis.secondaryColor);
    }
    if (vis.shieldMesh) {
      vis.shieldMesh.material.uniforms.uColor!.value.copy(vis.primaryColor);
      vis.shieldMesh.material.uniforms.uLife!.value = asNumber(inst.params.hp01, 1);
      vis.shieldMesh.material.uniforms.uHexScale!.value = asNumber(inst.params.hexScale, 3.0);
    }
  }

  private handleInstanceUpdate(inst: Readonly<LiveEffectState>, dt: number): void {
    const vis = this.visuals.get(inst.handle);
    if (!vis) return;

    const fadeAlpha =
      inst.state === "interrupting" && inst.fadeDuration > 0
        ? Math.max(0, inst.fadeRemaining / inst.fadeDuration)
        : inst.def.timing.duration > 0
          ? Math.min(1, Math.max(0, (inst.def.timing.duration - inst.age) / 0.35))
          : 1;

    if (inst.binding.kind === "spline" && inst.binding.waypoints && inst.binding.waypoints.length >= 2) {
      const waypoints = inst.binding.waypoints;
      const tProgress = Math.min(1, inst.age / Math.max(0.1, vis.travelSeconds));
      sampleSpline(waypoints, tProgress, this._samplePos, this._sampleTan);

      if (vis.shellMesh) {
        vis.shellMesh.position.set(this._samplePos[0], this._samplePos[1] + 0.65, this._samplePos[2]);
        const s =
          vis.elementMode === 4
            ? 0.95 + 0.14 * Math.sin(inst.age * 8)
            : (1 - tProgress * 0.2) * 0.72;
        vis.shellMesh.scale.setScalar(s * (vis.detonated ? Math.max(0.1, fadeAlpha) : 1));
      }

      if (vis.splineRibbon) {
        vis.splineRibbon.material.uniforms.uTime!.value = this.elapsedTime;
        vis.splineRibbon.material.uniforms.uProgress!.value = Math.max(0.12, tProgress);
        vis.splineRibbon.material.uniforms.uFade!.value = fadeAlpha;
      }

      // Blaze Path: surging Inferno Pillar rising straight up from detonation point
      if (vis.pillarMesh) {
        const shootH = Math.min(1, tProgress * 1.45) * (vis.detonated ? 0.65 + 0.35 * fadeAlpha : 1);
        const rad = vis.pillarRadius ?? 2.2;
        vis.pillarMesh.position.y = waypoints[waypoints.length - 1]![1] + 3.65 * shootH;
        vis.pillarMesh.scale.set(rad, Math.max(0.1, shootH), rad);
        vis.pillarMesh.material.uniforms.uTime!.value = this.elapsedTime;
        vis.pillarMesh.material.uniforms.uReveal!.value = fadeAlpha;
      }

      // Tidal Surge: massive 3D curling ocean wave riding along spline tangent
      if (vis.waveMesh) {
        vis.waveMesh.position.set(this._samplePos[0], this._samplePos[1] + 0.05, this._samplePos[2]);
        const yaw = Math.atan2(this._sampleTan[0], this._sampleTan[2]);
        vis.waveMesh.rotation.y = yaw;
        const grow = Math.min(1.18, 0.78 + tProgress * 0.42);
        vis.waveMesh.scale.set(grow, grow, grow);
        vis.waveMesh.material.uniforms.uTime!.value = this.elapsedTime;
        vis.waveMesh.material.uniforms.uReveal!.value = fadeAlpha;
      }

      // Glacial Spike: Absolute-Zero freeze disc expands cleanly as frost lands
      if (vis.freezeDisc) {
        const expand = Math.min(1, tProgress * 1.35);
        vis.freezeDisc.scale.setScalar(Math.max(0.15, expand));
        vis.freezeDisc.material.uniforms.uTime!.value = this.elapsedTime;
        vis.freezeDisc.material.uniforms.uReveal!.value = fadeAlpha;
      }

      if (vis.spikes) {
        for (const spike of vis.spikes) {
          const ud = spike.userData as { t: number; baseY: number; targetH: number };
          const emerge = Math.min(1, Math.max(0, (tProgress - ud.t + 0.14) / 0.18));
          const sink = fadeAlpha;
          const curH = emerge * sink;
          spike.position.y = ud.baseY - 0.6 + curH * 0.95;
          spike.scale.y = Math.max(0.05, ud.targetH * curH);
        }
      }

      // Emit textured elemental billboard particles continuously along the active spline segment.
      if (vis.hasCurveEmitter && !vis.detonated) {
        vis.emitCarry += (vis.curveCount / Math.max(0.15, vis.travelSeconds)) * dt;
        const toSpawn = Math.min(26, Math.floor(vis.emitCarry));
        vis.emitCarry -= toSpawn;
        for (let i = 0; i < toSpawn; i++) {
          const along = Math.max(0, tProgress - nextRand(vis) * 0.34);
          sampleSpline(waypoints, along, this._samplePos, this._sampleTan);
          const upVel =
            vis.elementMode === 1
              ? 1.4 + nextRand(vis) * 2.6
              : vis.elementMode === 2
                ? 0.9 + nextRand(vis) * 2.1
                : vis.elementMode === 3
                  ? 2.0 + nextRand(vis) * 3.0
                  : 0.7 + nextRand(vis) * 1.8;
          this.spawnParticle(
            vis,
            this._samplePos[0] + (nextRand(vis) - 0.5) * vis.curveSpread * 1.3,
            this._samplePos[1] + 0.28 + nextRand(vis) * vis.curveSpread * 0.85,
            this._samplePos[2] + (nextRand(vis) - 0.5) * vis.curveSpread * 1.3,
            this._sampleTan[0] * vis.curveSpeed * 0.22 + (nextRand(vis) - 0.5) * 2.2,
            upVel,
            this._sampleTan[2] * vis.curveSpeed * 0.22 + (nextRand(vis) - 0.5) * 2.2,
            0.42 + nextRand(vis) * 0.45,
            vis.curveRadius * (1.1 + nextRand(vis) * 1.25),
          );
        }
      }

      if (tProgress >= 1 && !vis.detonated) {
        this.detonateSplineOrEndpoint(inst, vis);
      }
    } else {
      if (vis.shellMesh) {
        vis.shellMesh.position.set(vis.anchor.x, vis.anchor.y + 0.95, vis.anchor.z);
        vis.shellMesh.scale.setScalar(0.8 * fadeAlpha);
      }
      if (vis.shieldMesh) {
        vis.shieldMesh.position.set(vis.anchor.x, vis.anchor.y + 1.05, vis.anchor.z);
        vis.shieldMesh.material.uniforms.uTime!.value = inst.age;
        vis.shieldMesh.material.uniforms.uReveal!.value = fadeAlpha;
      }
      if (vis.iceRingGroup) {
        vis.iceRingGroup.position.set(vis.anchor.x, vis.anchor.y, vis.anchor.z);
        vis.iceRingGroup.scale.setScalar(Math.max(0.15, fadeAlpha));
      }
    }

    if (vis.shellMesh) {
      vis.shellMesh.material.uniforms.uTime!.value = inst.age;
      vis.shellMesh.material.uniforms.uReveal!.value = fadeAlpha;
    }
  }

  private detonateSplineOrEndpoint(inst: Readonly<LiveEffectState>, vis: InstanceVisual): void {
    vis.detonated = true;
    const waypoints = inst.binding.waypoints;
    const end = waypoints && waypoints.length > 0
      ? waypoints[waypoints.length - 1]!
      : inst.binding.pos ?? [vis.anchor.x, vis.anchor.y, vis.anchor.z];

    if (vis.hasPool) {
      const burst = Math.min(72, Math.max(24, Math.floor(vis.poolCount * 0.38)));
      this.emitBurst(vis, end[0], end[1] + 0.4, end[2], burst);
    }
    if (vis.hasRingBurst) {
      const rings = Math.min(3, Math.max(1, vis.ringCount));
      for (let r = 0; r < rings; r++) {
        this.triggerRing(
          end[0],
          end[1] + 0.14 + r * 0.04,
          end[2],
          r % 2 === 0 ? vis.primaryColor : vis.secondaryColor,
          2.6 + r * 0.9,
        );
      }
    }
  }

  private emitBurst(
    vis: InstanceVisual,
    x: number,
    y: number,
    z: number,
    count: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const angle = nextRand(vis) * Math.PI * 2;
      const spd = 1.6 + nextRand(vis) * 4.8;
      const up = vis.elementMode === 3 ? 2.6 + nextRand(vis) * 3.8 : 1.1 + nextRand(vis) * 3.0;
      this.spawnParticle(
        vis,
        x + (nextRand(vis) - 0.5) * 0.4,
        y + nextRand(vis) * 0.3,
        z + (nextRand(vis) - 0.5) * 0.4,
        Math.cos(angle) * spd,
        up,
        Math.sin(angle) * spd,
        0.48 + nextRand(vis) * 0.48,
        0.75 + nextRand(vis) * 0.95,
      );
    }
  }

  private spawnParticle(
    vis: InstanceVisual,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    maxAge: number,
    size: number,
  ): void {
    const idx = this.pCursor;
    this.pCursor = (this.pCursor + 1) % MAX_PARTICLES;

    this.pActive[idx] = 1;
    this.pPx[idx] = x;
    this.pPy[idx] = y;
    this.pPz[idx] = z;
    this.pVx[idx] = vx;
    this.pVy[idx] = vy;
    this.pVz[idx] = vz;
    this.pAge[idx] = 0;
    this.pMaxAge[idx] = maxAge;
    this.pSize[idx] = size;
    this.pMode[idx] = vis.elementMode;
    this.pSeed[idx] = nextRand(vis);
    this.pSpin[idx] = (nextRand(vis) - 0.5) * 0.7;
    this.pSpinVel[idx] = vis.elementMode === 4 || vis.elementMode === 3 ? (nextRand(vis) - 0.5) * 5.0 : (nextRand(vis) - 0.5) * 1.2;

    const blend = nextRand(vis) * 0.45;
    this.pR[idx] = vis.primaryColor.r * (1 - blend) + vis.secondaryColor.r * blend;
    this.pG[idx] = vis.primaryColor.g * (1 - blend) + vis.secondaryColor.g * blend;
    this.pB[idx] = vis.primaryColor.b * (1 - blend) + vis.secondaryColor.b * blend;
  }

  private triggerRing(
    x: number,
    y: number,
    z: number,
    color: THREE.Color,
    maxRadius: number,
  ): void {
    for (let i = 0; i < this.ringPool.length; i++) {
      const slot = this.ringPool[i]!;
      if (!slot.active) {
        slot.active = true;
        slot.age = 0;
        slot.duration = 0.62;
        slot.maxRadius = maxRadius;
        slot.mesh.position.set(x, y, z);
        slot.mesh.scale.setScalar(0.2);
        slot.mesh.material.uniforms.uLife!.value = 0;
        slot.mesh.material.uniforms.uColor!.value.copy(color);
        slot.mesh.visible = true;
        return;
      }
    }
  }

  private updateParticles(dt: number): void {
    let writeIdx = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pActive[i] === 0) continue;
      const age = this.pAge[i]! + dt;
      const maxAge = this.pMaxAge[i]!;
      if (age >= maxAge) {
        this.pActive[i] = 0;
        continue;
      }
      this.pAge[i] = age;

      const mode = this.pMode[i]!;
      // Earth rock shards & water splash droplets experience downward gravity; fire/air buoy up
      const gravity = mode === 3 ? -9.8 : mode === 2 ? -5.5 : 2.1;
      const vy = this.pVy[i]! + gravity * dt;
      this.pVy[i] = vy;

      const x = this.pPx[i]! + this.pVx[i]! * dt;
      const y = this.pPy[i]! + vy * dt;
      const z = this.pPz[i]! + this.pVz[i]! * dt;
      this.pPx[i] = x;
      this.pPy[i] = y;
      this.pPz[i] = z;

      const spin = this.pSpin[i]! + this.pSpinVel[i]! * dt;
      this.pSpin[i] = spin;

      const life = age / maxAge;
      const baseScale = this.pSize[i]! * (mode === 1 ? 0.8 + life * 0.55 : 1 - life * 0.45);
      const scaleX = Math.max(0.08, baseScale * (mode === 5 ? 0.65 : 1.0));
      const scaleY = Math.max(0.08, baseScale * (mode === 1 ? 1.45 : mode === 5 ? 1.55 : 1.05));
      this._obj.position.set(x, y, z);
      this._obj.scale.set(scaleX, scaleY, scaleX);
      this._obj.updateMatrix();
      this.particles.setMatrixAt(writeIdx, this._obj.matrix);

      const mOff = writeIdx * 4;
      this.pMetaArray[mOff] = life;
      this.pMetaArray[mOff + 1] = this.pSeed[i]!;
      this.pMetaArray[mOff + 2] = mode;
      this.pMetaArray[mOff + 3] = spin;

      const cOff = writeIdx * 3;
      this.pColorArray[cOff] = this.pR[i]!;
      this.pColorArray[cOff + 1] = this.pG[i]!;
      this.pColorArray[cOff + 2] = this.pB[i]!;
      writeIdx++;
    }

    const prevCount = this.activeParticleRenderCount;
    this.activeParticleRenderCount = writeIdx;
    this.particles.count = writeIdx;
    if (writeIdx > 0 || prevCount > 0) {
      this.particles.instanceMatrix.needsUpdate = true;
      this.pMetaAttr.needsUpdate = true;
      this.pColorAttr.needsUpdate = true;
    }
  }

  private updateRings(dt: number): void {
    for (let i = 0; i < this.ringPool.length; i++) {
      const slot = this.ringPool[i]!;
      if (!slot.active) continue;
      slot.age += dt;
      if (slot.age >= slot.duration) {
        slot.active = false;
        slot.mesh.visible = false;
        continue;
      }
      const u = slot.age / slot.duration;
      const radius = 0.25 + (slot.maxRadius - 0.25) * (1 - (1 - u) * (1 - u));
      slot.mesh.scale.setScalar(radius);
      slot.mesh.material.uniforms.uLife!.value = u;
    }
  }

  private handleDispose(inst: Readonly<LiveEffectState>): void {
    const vis = this.visuals.get(inst.handle);
    if (!vis) return;
    this.visuals.delete(inst.handle);
    if (vis.shellMesh) {
      this.group.remove(vis.shellMesh);
      vis.shellMesh.material.dispose();
    }
    if (vis.shieldMesh) {
      this.group.remove(vis.shieldMesh);
      vis.shieldMesh.material.dispose();
    }
    if (vis.splineRibbon) {
      this.group.remove(vis.splineRibbon);
      vis.splineRibbon.geometry.dispose();
      vis.splineRibbon.material.dispose();
    }
    if (vis.spikes) {
      for (const spike of vis.spikes) {
        this.group.remove(spike);
        (spike.material as THREE.Material).dispose();
      }
    }
    if (vis.pillarMesh) {
      this.group.remove(vis.pillarMesh);
      vis.pillarMesh.material.dispose();
    }
    if (vis.waveMesh) {
      this.group.remove(vis.waveMesh);
      vis.waveMesh.material.dispose();
    }
    if (vis.freezeDisc) {
      this.group.remove(vis.freezeDisc);
      vis.freezeDisc.material.dispose();
    }
    if (vis.iceRingGroup) {
      this.group.remove(vis.iceRingGroup);
      for (const child of vis.iceRingGroup.children) {
        const mesh = child as THREE.Mesh;
        (mesh.material as THREE.Material)?.dispose?.();
      }
    }
  }
}

function parseEntityId(id?: string): bigint | null {
  if (!id) return null;
  try {
    return BigInt(id);
  } catch {
    return null;
  }
}
