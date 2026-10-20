/**
 * CloudVolume — camera-local cloud billboards whose coverage/darkness
 * follow the field's moisture over the player.
 *
 * A small number of instanced planes positioned in a slab above/around the
 * camera, drifting with the wind. Parameterised, NOT simulated: the
 * coverage and darkness are driven externally by the field's moisture and
 * the weather sample's intensity. Reuses the instancing pattern from
 * instanced-props.ts (one InstancedMesh, one draw call, frustumCulled off).
 */

import * as THREE from "three";

/** Number of cloud billboards. */
const CLOUD_COUNT = 10;
/** Cloud slab height range (metres above the camera). */
const CLOUD_HEIGHT_MIN = 60;
const CLOUD_HEIGHT_RANGE = 40;
/** Cloud slab radius around the camera. */
const CLOUD_RADIUS_MIN = 100;
const CLOUD_RADIUS_RANGE = 400;
/** Wrap distance: clouds past this from the camera respawn on the other side. */
const CLOUD_WRAP = 500;
const CLOUD_WRAP_TOTAL = CLOUD_WRAP * 2;

const CLOUD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CLOUD_FRAGMENT = /* glsl */ `
uniform float uOpacity;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float alpha = smoothstep(1.0, 0.3, d) * uOpacity;
  gl_FragColor = vec4(uColor, alpha);
}
`;

/**
 * A small number of camera-local cloud volumes. Coverage and darkness
 * follow the field's moisture over the player.
 */
export class CloudVolume {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private readonly count: number;
  private readonly material: THREE.ShaderMaterial;
  private readonly uniforms: { uOpacity: { value: number }; uColor: { value: THREE.Color } };
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly scratchScale = new THREE.Vector3();
  /** Per-cloud base scale (width, height). */
  private readonly baseScales: Array<{ w: number; h: number }> = [];

  constructor(count = CLOUD_COUNT) {
    this.count = count;
    this.group.name = "clouds";

    this.uniforms = {
      uOpacity: { value: 0 },
      uColor: { value: new THREE.Color(0.8, 0.8, 0.85) },
    };

    const geometry = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERTEX,
      fragmentShader: CLOUD_FRAGMENT,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.InstancedMesh(geometry, this.material, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    // Position clouds in a slab around the origin (they follow the camera).
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = CLOUD_RADIUS_MIN + Math.random() * CLOUD_RADIUS_RANGE;
      const h = 120 + Math.random() * 60;
      const w = 80 + Math.random() * 60;
      this.baseScales.push({ w, h });
      this.scratchPos.set(Math.cos(angle) * radius, CLOUD_HEIGHT_MIN + Math.random() * CLOUD_HEIGHT_RANGE, Math.sin(angle) * radius);
      this.scratchScale.set(w, h, 1);
      this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
      this.mesh.setMatrixAt(i, this.scratchMatrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Follow the camera and update cloud appearance from the field's moisture.
   *
   * @param cameraPos Camera position (clouds follow this).
   * @param moisture 0..1 moisture over the player (from the field).
   * @param darkness 0..1 additional darkening (from the weather sample).
   * @param windX Wind x-component (clouds drift with this).
   * @param windZ Wind z-component.
   * @param dt Delta time in seconds.
   * @param cameraQuat Camera quaternion (clouds billboard toward the camera).
   */
  update(
    cameraPos: THREE.Vector3,
    moisture: number,
    darkness: number,
    windX: number,
    windZ: number,
    dt: number,
    cameraQuat: THREE.Quaternion,
  ): void {
    const coverage = Math.min(1, moisture * 0.7 + darkness * 0.3);
    this.uniforms.uOpacity.value = 0.15 + coverage * 0.55;
    const brightness = 0.85 - coverage * 0.45;
    this.uniforms.uColor.value.setScalar(brightness);

    this.scratchQuat.copy(cameraQuat);
    for (let i = 0; i < this.count; i++) {
      this.mesh.getMatrixAt(i, this.scratchMatrix);
      this.scratchMatrix.decompose(this.scratchPos, this.scratchQuat, this.scratchScale);
      this.scratchPos.x += windX * dt;
      this.scratchPos.z += windZ * dt;
      // Wrap around the camera.
      const dx = this.scratchPos.x - cameraPos.x;
      const dz = this.scratchPos.z - cameraPos.z;
      if (dx > CLOUD_WRAP) this.scratchPos.x -= CLOUD_WRAP_TOTAL;
      else if (dx < -CLOUD_WRAP) this.scratchPos.x += CLOUD_WRAP_TOTAL;
      if (dz > CLOUD_WRAP) this.scratchPos.z -= CLOUD_WRAP_TOTAL;
      else if (dz < -CLOUD_WRAP) this.scratchPos.z += CLOUD_WRAP_TOTAL;
      // Keep clouds above the camera.
      if (this.scratchPos.y < cameraPos.y + 20) this.scratchPos.y = cameraPos.y + 20 + Math.random() * 20;
      this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
      this.mesh.setMatrixAt(i, this.scratchMatrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
