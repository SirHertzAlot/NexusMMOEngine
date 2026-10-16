/**
 * DissolveMaterial - dissolve/reveal effect using noise threshold.
 *
 * For: enemy death, burning objects, teleportation, spawn effects, building decay
 */
import * as THREE from "three";

const dissolveFragmentShader = `
uniform sampler2D uDissolveMap;
uniform sampler2D uColorRamp;
uniform float uDissolveProgress;
uniform float uEdgeWidth;
uniform vec3 uBaseColor;

varying vec2 vUv;

void main() {
  float noise = texture2D(uDissolveMap, vUv).r;
  float threshold = clamp(uDissolveProgress, 0.0, 1.0);

  float isDissolved = step(noise, threshold);
  float edge = smoothstep(threshold - uEdgeWidth, threshold, noise);

  vec3 rampColor = texture2D(uColorRamp, vec2(edge, 0.5)).rgb;

  vec3 color = mix(uBaseColor, rampColor, edge);
  float alpha = 1.0 - isDissolved;

  gl_FragColor = vec4(color, alpha);
}
`;

/**
 * DissolveMaterial for death, burning, teleportation effects.
 *
 * Uniforms:
 * - uDissolveMap: noise map for dissolve pattern
 * - uColorRamp: 1D gradient for edge color
 * - uDissolveProgress: 0-1 (0=intact, 1=fully dissolved)
 * - uEdgeWidth: edge highlight width
 * - uBaseColor: base object color
 */
export class DissolveMaterial extends THREE.ShaderMaterial {
  constructor(options: {
    name?: string;
    transparent?: boolean;
    depthWrite?: boolean;
  } = {}) {
    super({
      name: options.name ?? "DissolveMaterial",
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: dissolveFragmentShader,
      transparent: options.transparent ?? true,
      depthWrite: options.depthWrite ?? true,
      uniforms: {
        uDissolveMap: { value: null },
        uColorRamp: { value: null },
        uDissolveProgress: { value: 0 },
        uEdgeWidth: { value: 0.05 },
        uBaseColor: { value: new THREE.Color(0.35, 0.32, 0.30) },
      },
    });
  }

  setProgress(progress: number): void {
    this.uniforms.uDissolveProgress.value = THREE.MathUtils.clamp(progress, 0, 1);
  }

  setEdgeWidth(width: number): void {
    this.uniforms.uEdgeWidth.value = width;
  }

  setBaseColor(color: THREE.Color): void {
    this.uniforms.uBaseColor.value = color;
  }

  setDissolveMap(t: THREE.Texture | null): void {
    this.uniforms.uDissolveMap.value = t;
  }

  setColorRamp(t: THREE.Texture | null): void {
    this.uniforms.uColorRamp.value = t;
  }
}

export { DissolveMaterial as default };