/**
 * WorldFlowMaterial - flow effect anchored to world XZ position.
 *
 * Uses world XZ as UV - anchors effect to world instead of sliding with mesh/camera.
 * For: ground dust, rain ripples, river flow, magic circles, portal ground rings.
 */
import * as THREE from "three";

const worldFlowVertexShader = `
varying vec2 vWorldUv;
varying vec3 vWorldPosition;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  vWorldUv = worldPos.xz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const worldFlowFragmentShader = `
uniform sampler2D uEffectTexture;
uniform sampler2D uFlowMap;
uniform float uTime;
uniform float uTiling;
uniform float uFlowSpeed;
uniform float uFlowStrength;
uniform vec3 uEmitterCenter;
uniform float uEffectRadius;
uniform vec3 uDarkColor;
uniform vec3 uLightColor;
uniform float uIntensity;

varying vec2 vWorldUv;
varying vec3 vWorldPosition;

vec2 decodeFlow(vec2 flowSample) {
  return flowSample * 2.0 - 1.0;
}

void main() {
  vec2 worldUv = vWorldUv * uTiling;
  vec2 flow = texture2D(uFlowMap, worldUv).rg * 2.0 - 1.0;

  float cycle = uTime * uFlowSpeed;
  float phase = fract(cycle);

  vec2 dustUv = fract(worldUv + flow * phase * uFlowStrength);
  float dust = texture2D(uEffectTexture, dustUv).r;

  // Distance fade
  float dx = vWorldPosition.x - uEmitterCenter.x;
  float dz = vWorldPosition.z - uEmitterCenter.z;
  float dist = sqrt(dx * dx + dz * dz);
  float distanceFade = 1.0 - smoothstep(0.0, uEffectRadius, dist);

  float alpha = dust * uIntensity * distanceFade;
  vec3 color = mix(uDarkColor, uLightColor, dust);

  gl_FragColor = vec4(color, alpha);
}
`;

/**
 * WorldFlowMaterial - anchored to world position.
 *
 * Uniforms:
 * - uEffectTexture: effect texture (dust, water, etc.)
 * - uFlowMap: flow map
 * - uTiling: world-space UV tiling
 * - uFlowSpeed: animation speed
 * - uFlowStrength: flow distance per cycle
 * - uEmitterCenter: center for distance fade
 * - uEffectRadius: fade radius
 * - uDarkColor/uLightColor: color range
 * - uIntensity: overall intensity
 */
export class WorldFlowMaterial extends THREE.ShaderMaterial {
  constructor(options: {
    name?: string;
    transparent?: boolean;
    depthWrite?: boolean;
    blending?: THREE.Blending;
  } = {}) {
    super({
      name: options.name ?? "WorldFlowMaterial",
      vertexShader: worldFlowVertexShader,
      fragmentShader: worldFlowFragmentShader,
      transparent: options.transparent ?? true,
      depthWrite: options.depthWrite ?? false,
      blending: options.blending ?? THREE.NormalBlending,
      uniforms: {
        uEffectTexture: { value: null },
        uFlowMap: { value: null },
        uTiling: { value: 0.05 },
        uFlowSpeed: { value: 0.18 },
        uFlowStrength: { value: 1.0 },
        uEmitterCenter: { value: new THREE.Vector3(0, 0, 0) },
        uEffectRadius: { value: 50 },
        uDarkColor: { value: new THREE.Color(0.3, 0.25, 0.2) },
        uLightColor: { value: new THREE.Color(0.8, 0.7, 0.6) },
        uIntensity: { value: 1.0 },
        uTime: { value: 0 },
      },
    });
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
  }

  // Setters
  setEffectTexture(t: THREE.Texture | null) { this.uniforms.uEffectTexture.value = t; }
  setFlowMap(t: THREE.Texture | null) { this.uniforms.uFlowMap.value = t; }
  setTiling(v: number) { this.uniforms.uTiling.value = v; }
  setFlowSpeed(v: number) { this.uniforms.uFlowSpeed.value = v; }
  setFlowStrength(v: number) { this.uniforms.uFlowStrength.value = v; }
  setEmitterCenter(v: THREE.Vector3) { this.uniforms.uEmitterCenter.value = v; }
  setEffectRadius(v: number) { this.uniforms.uEffectRadius.value = v; }
  setDarkColor(c: THREE.Color) { this.uniforms.uDarkColor.value = c; }
  setLightColor(c: THREE.Color) { this.uniforms.uLightColor.value = c; }
  setIntensity(v: number) { this.uniforms.uIntensity.value = v; }
}

export { WorldFlowMaterial as default };