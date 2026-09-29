/**
 * The sky as a shader function, shared by the sky dome and the water: the
 * water reflects the sky by evaluating the same function in the reflected
 * direction, with the same uniform objects, so reflections follow the time
 * of day with no reflection render pass.
 *
 * Adapted from ProceduralTerrains' proceduralSkyGLSL.js (MIT, © 2026
 * ZyFou; see THIRD_PARTY_NOTICES.md). Colours are linear.
 */

import * as THREE from "three";

export const SKY_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform vec3 uSunDir;
uniform float uLight;
uniform float uHaze;
uniform float uStars;
`;

/**
 * `vec3 evaluateSky(vec3 dir, float discStrength, float starStrength)`:
 * the sky's linear colour looking along `dir`. The water passes a weaker
 * sun disc (its own specular draws the glint) and fewer stars.
 */
export const SKY_EVAL_GLSL = /* glsl */ `
vec3 evaluateSky(vec3 direction, float discStrength, float starStrength) {
  vec3 dir = normalize(direction);
  float y = dir.y;

  float horizonBlend = 1.0 - pow(max(y, 0.0), 0.45);
  vec3 sky = mix(uZenith, uHorizon, horizonBlend);
  float hazeBand = exp(-abs(y) * 8.0);
  sky = mix(sky, uFogColor, hazeBand * uHaze);
  if (y < 0.0) sky = mix(sky, uFogColor, clamp(-y * 5.0, 0.0, 1.0));

  float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
  float disc = smoothstep(0.9994, 0.9998, sunDot);
  float glow = pow(sunDot, 256.0) * 0.8;
  float halo = pow(sunDot, 32.0) * 0.25;
  vec3 sun = uSunColor * uLight;
  sky += sun * (disc * 3.0 * discStrength + glow * mix(0.35, 1.0, discStrength) + halo);
  sky += uSunColor * pow(sunDot, 8.0) * 0.08 * exp(-abs(y) * 3.0) * uLight;
  sky += uSunColor * pow(sunDot, 4.0) * hazeBand * 0.3 * uLight * 1.35;
  sky += uHorizon * hazeBand * 0.35 * 0.35;

  float night = smoothstep(0.15, -0.1, uSunDir.y) * uStars * starStrength;
  if (night > 0.01 && y > 0.0) {
    vec3 cell = floor(dir * 300.0);
    vec3 p = fract(cell * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    float h = fract((p.x + p.y) * p.z);
    float star = step(0.998, h) * pow(max(y, 0.0), 0.3);
    float twinkle = 0.7 + 0.3 * sin(h * 6283.0 + cell.x * 0.5);
    sky += vec3(0.8, 0.85, 1.0) * star * twinkle * night * 0.6;
  }
  return max(sky, vec3(0.0));
}
`;

export interface SkyUniforms {
  [name: string]: THREE.IUniform;
  uZenith: THREE.IUniform<THREE.Color>;
  uHorizon: THREE.IUniform<THREE.Color>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uFogColor: THREE.IUniform<THREE.Color>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uLight: THREE.IUniform<number>;
  uHaze: THREE.IUniform<number>;
  uStars: THREE.IUniform<number>;
}

/** Fresh sky uniforms at a neutral midday (DaySky sets them every frame). */
export function createSkyUniforms(): SkyUniforms {
  return {
    uZenith: { value: new THREE.Color(0.18, 0.35, 0.72) },
    uHorizon: { value: new THREE.Color(0.5, 0.62, 0.78) },
    uSunColor: { value: new THREE.Color(1.0, 0.98, 0.92) },
    uFogColor: { value: new THREE.Color(0.55, 0.62, 0.75) },
    uSunDir: { value: new THREE.Vector3(0, 0.9, 0.44).normalize() },
    uLight: { value: 1.5 },
    uHaze: { value: 0.55 },
    uStars: { value: 1 },
  };
}
