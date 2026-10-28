/**
 * RainCurtain — rain as a cheap scrolling shader with the field's wind
 * vector.
 *
 * A single camera-facing quad with a procedural rain shader: streaks fall
 * and scroll with the wind. Cheap (one draw call), no particle flood.
 * Respects quality tiers: the caller shows/hides it based on the preset.
 */

import * as THREE from "three";

const RAIN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RAIN_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uIntensity;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv = vUv * 30.0;
  uv.y += uTime * 2.5;
  uv.x += uWind.x * uTime * 0.8;
  uv.y += uWind.y * uTime * 0.8;

  float streak = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 p = uv + vec2(fi * 0.37, fi * 0.11);
    float h = hash(floor(p));
    float col = fract(p.x);
    if (col < 0.12 && fract(p.y * (0.5 + h)) < 0.35) {
      streak = max(streak, 0.4 + 0.6 * h);
    }
  }

  gl_FragColor = vec4(vec3(0.7, 0.8, 0.9), streak * uIntensity * 0.25);
}
`;

/**
 * A scrolling rain shader driven by the field's wind vector. One quad,
 * one draw call, no particles.
 */
export class RainCurtain {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly uniforms: {
    uTime: { value: number };
    uWind: { value: THREE.Vector2 };
    uIntensity: { value: number };
  };

  constructor() {
    this.uniforms = {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(0, 0) },
      uIntensity: { value: 0 },
    };
    const geometry = new THREE.PlaneGeometry(200, 100);
    this.material = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERTEX,
      fragmentShader: RAIN_FRAGMENT,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = "rain-curtain";
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
  }

  /**
   * Update the rain shader.
   *
   * @param time Elapsed seconds (drives the scroll).
   * @param windX Wind x-component (field's wind vector).
   * @param windZ Wind z-component.
   * @param intensity 0..1 rain intensity (0 hides the curtain).
   * @param cameraPos Camera position (the curtain follows this).
   */
  update(time: number, windX: number, windZ: number, intensity: number, cameraPos: THREE.Vector3): void {
    this.uniforms.uTime.value = time;
    this.uniforms.uWind.value.set(windX, windZ);
    this.uniforms.uIntensity.value = intensity;
    this.mesh.visible = intensity > 0.01;
    if (this.mesh.visible) {
      this.mesh.position.set(cameraPos.x, cameraPos.y + 30, cameraPos.z);
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
