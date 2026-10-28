/**
 * PolarFlowMaterial - polar coordinate flow for portals, vortices, magic circles.
 *
 * Converts UV to polar (angle, radius) space for swirling effects.
 */
import * as THREE from "three";

const polarVertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

const polarFragmentShader = `
uniform sampler2D uEffectTexture;
uniform sampler2D uFlowMap;
uniform sampler2D uNoiseMap;
uniform sampler2D uColorRamp;
uniform float uTime;
uniform float uSwirlSpeed;
uniform float uSwirlStrength;
uniform float uEdgeInner;
uniform float uEdgeOuter;
uniform vec3 uBaseColor;
uniform float uEmissiveIntensity;

varying vec2 vUv;

vec2 decodeFlow(vec2 flowSample) {
  return flowSample * 2.0 - 1.0;
}

const float PI = 3.14159265359;

mat2 rotate2d(float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return mat2(c, -s, s, c);
}

void main() {
  vec2 centered = vUv - vec2(0.5, 0.5);
  float angle = atan(centered.y, centered.x);
  float radius = length(centered);
  float normalizedAngle = (angle + PI) / (2.0 * PI);
  vec2 polarUv = vec2(normalizedAngle, radius);

  vec2 flow = texture2D(uFlowMap, polarUv).rg * 2.0 - 1.0;

  // Two-phase blending for seamless wrap
  float cycle = uTime * uSwirlSpeed;
  float phaseA = fract(cycle);
  float phaseB = fract(cycle + 0.5);
  float blend = abs(phaseA * 2.0 - 1.0);

  vec2 swirlUvA = vUv + flow * phaseA * uSwirlStrength;
  vec2 swirlUvB = vUv + flow * phaseB * uSwirlStrength;

  float rotationAngle = uTime * uSwirlSpeed;
  mat2 rotation = rotate2d(rotationAngle);

  vec2 centeredA = swirlUvA - vec2(0.5, 0.5);
  vec2 rotatedA = rotation * centeredA + vec2(0.5, 0.5);

  vec2 centeredB = swirlUvB - vec2(0.5, 0.5);
  vec2 rotatedB = rotation * centeredB + vec2(0.5, 0.5);

  float energyA = texture2D(uNoiseMap, rotatedA).r;
  float energyB = texture2D(uNoiseMap, rotatedB).r;

  float edgeFadeA = 1.0 - smoothstep(uEdgeInner, uEdgeOuter, radius);
  float edgeFadeB = 1.0 - smoothstep(uEdgeInner, uEdgeOuter, radius);

  vec3 portalColorA = texture2D(uColorRamp, vec2(energyA, 0.5)).rgb;
  vec3 portalColorB = texture2D(uColorRamp, vec2(energyB, 0.5)).rgb;

  vec3 colorA = portalColorA * edgeFadeA;
  vec3 colorB = portalColorB * edgeFadeB;

  vec3 finalColor = mix(colorA, colorB, blend);
  float alpha = mix(edgeFadeA, edgeFadeB, blend) * mix(energyA, energyB, blend);

  vec3 emissive = finalColor * uEmissiveIntensity;

  gl_FragColor = vec4(finalColor * uBaseColor + emissive, alpha);
}
`;

/**
 * PolarFlowMaterial for portals, vortices, magic circles.
 *
 * Uniforms:
 * - uEffectTexture: portal texture
 * - uFlowMap: flow map in polar space
 * - uNoiseMap: noise for energy variation
 * - uColorRamp: 1D gradient for color
 * - uSwirlSpeed: rotation speed
 * - uSwirlStrength: flow strength
 * - uEdgeInner/uEdgeOuter: fade radii
 * - uBaseColor: color tint
 * - uEmissiveIntensity: glow intensity
 */
export class PolarFlowMaterial extends THREE.ShaderMaterial {
  constructor(options: {
    name?: string;
    transparent?: boolean;
    depthWrite?: boolean;
    blending?: THREE.Blending;
  } = {}) {
    super({
      name: options.name ?? "PolarFlowMaterial",
      vertexShader: polarVertexShader,
      fragmentShader: polarFragmentShader,
      transparent: options.transparent ?? true,
      depthWrite: options.depthWrite ?? false,
      blending: options.blending ?? THREE.AdditiveBlending,
      uniforms: {
        uEffectTexture: { value: null },
        uFlowMap: { value: null },
        uNoiseMap: { value: null },
        uColorRamp: { value: null },
        uTime: { value: 0 },
        uSwirlSpeed: { value: 0.55 },
        uSwirlStrength: { value: 0.35 },
        uEdgeInner: { value: 0.35 },
        uEdgeOuter: { value: 0.5 },
        uBaseColor: { value: new THREE.Color(1, 1, 1) },
        uEmissiveIntensity: { value: 1.0 },
      },
    });
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
  }

  // Setters
  setEffectTexture(t: THREE.Texture | null) { this.uniforms.uEffectTexture.value = t; }
  setFlowMap(t: THREE.Texture | null) { this.uniforms.uFlowMap.value = t; }
  setNoiseMap(t: THREE.Texture | null) { this.uniforms.uNoiseMap.value = t; }
  setColorRamp(t: THREE.Texture | null) { this.uniforms.uColorRamp.value = t; }
  setSwirlSpeed(v: number) { this.uniforms.uSwirlSpeed.value = v; }
  setSwirlStrength(v: number) { this.uniforms.uSwirlStrength.value = v; }
  setEdgeInner(v: number) { this.uniforms.uEdgeInner.value = v; }
  setEdgeOuter(v: number) { this.uniforms.uEdgeOuter.value = v; }
  setBaseColor(c: THREE.Color) { this.uniforms.uBaseColor.value = c; }
  setEmissiveIntensity(v: number) { this.uniforms.uEmissiveIntensity.value = v; }
}

export { PolarFlowMaterial as default };