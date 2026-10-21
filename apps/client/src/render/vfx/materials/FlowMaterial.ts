/**
 * FlowMaterial - custom Three.js shader material for flow-based effects.
 *
 * Uses two-phase flow blending for seamless UV wrapping.
 * Works with standard Three.js (not TSL) for compatibility.
 */
import * as THREE from "three";

const flowVertexShader = `
varying vec2 vUv;
varying vec3 vWorldPosition;

void main() {
  vUv = uv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const flowFragmentShader = `
uniform sampler2D uEffectTexture;
uniform sampler2D uFlowMap;
uniform float uTime;
uniform float uFlowSpeed;
uniform float uFlowStrength;
uniform vec3 uBaseColor;
uniform float uEmissiveIntensity;

varying vec2 vUv;
varying vec3 vWorldPosition;

vec2 decodeFlow(vec2 flowSample) {
  return flowSample * 2.0 - 1.0;
}

void main() {
  vec2 flow = decodeFlow(texture2D(uFlowMap, vUv).rg);

  float cycle = uTime * uFlowSpeed;
  float phaseA = fract(cycle);
  float phaseB = fract(cycle + 0.5);
  float blend = abs(phaseA * 2.0 - 1.0);

  vec2 uvA = fract(vUv + flow * phaseA * uFlowStrength);
  vec2 uvB = fract(vUv + flow * phaseB * uFlowStrength);

  vec4 sampleA = texture2D(uEffectTexture, uvA);
  vec4 sampleB = texture2D(uEffectTexture, uvB);

  vec4 color = mix(sampleA, sampleB, blend);
  color.rgb *= uBaseColor;
  color.a *= mix(sampleA.a, sampleB.a, blend);

  // Emissive glow
  vec3 emissive = color.rgb * uEmissiveIntensity;

  gl_FragColor = vec4(color.rgb + emissive, color.a);
}
`;

/**
 * Create a FlowMaterial for fire/smoke/energy effects.
 *
 * Uniforms:
 * - uEffectTexture: effect texture (fire, smoke, etc.)
 * - uFlowMap: RGBA flow map (R=X, G=Y, B=intensity, A=opacity)
 * - uTime: current time
 * - uFlowSpeed: animation speed (cycles/sec)
 * - uFlowStrength: UV offset distance per cycle
 * - uBaseColor: base color tint
 * - uEmissiveIntensity: emissive glow intensity
 */
export class FlowMaterial extends THREE.ShaderMaterial {
  constructor(options: {
    name?: string;
    transparent?: boolean;
    depthWrite?: boolean;
    blending?: THREE.Blending;
  } = {}) {
    super({
      name: options.name ?? "FlowMaterial",
      vertexShader: flowVertexShader,
      fragmentShader: flowFragmentShader,
      transparent: options.transparent ?? true,
      depthWrite: options.depthWrite ?? false,
      blending: options.blending ?? THREE.AdditiveBlending,
      uniforms: {
        uEffectTexture: { value: null },
        uFlowMap: { value: null },
        uTime: { value: 0 },
        uFlowSpeed: { value: 0.5 },
        uFlowStrength: { value: 1.0 },
        uBaseColor: { value: new THREE.Color(1, 1, 1) },
        uEmissiveIntensity: { value: 0 },
      },
    });
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
  }

  setEffectTexture(texture: THREE.Texture | null): void {
    this.uniforms.uEffectTexture.value = texture;
  }

  setFlowMap(texture: THREE.Texture | null): void {
    this.uniforms.uFlowMap.value = texture;
  }

  setFlowSpeed(speed: number): void {
    this.uniforms.uFlowSpeed.value = speed;
  }

  setFlowStrength(strength: number): void {
    this.uniforms.uFlowStrength.value = strength;
  }

  setBaseColor(color: THREE.Color): void {
    this.uniforms.uBaseColor.value = color;
  }

  setEmissiveIntensity(intensity: number): void {
    this.uniforms.uEmissiveIntensity.value = intensity;
  }
}

export { FlowMaterial as default };