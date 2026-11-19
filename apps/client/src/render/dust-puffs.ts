/**
 * Dust puffs (DE1), drawn: one Points object over the DustSim pool, soft round sprites that grow and fade.
 * One draw call and a fixed buffer however many props are hit.
 */

import * as THREE from "three";
import { DUST_CAPACITY, DUST_LIFE_S, DustSim } from "./dust-sim.js";

const VERT = /* glsl */ `
  attribute float aLife;
  varying float vLife;
  uniform float uScale;
  void main() {
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aLife >= 1.0 ? 0.0 : (14.0 + 34.0 * aLife) * uScale / max(0.5, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying float vLife;
  uniform vec3 uColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.2, d) * (1.0 - vLife) * 0.55;
    if (a <= 0.01) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

export class DustPuffs {
  readonly sim = new DustSim(DUST_CAPACITY, 0x9e3779b1);
  readonly points: THREE.Points;
  private readonly life = new Float32Array(DUST_CAPACITY);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private active = 0;

  constructor(scene: THREE.Object3D, color = 0xb8a888) {
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(DUST_CAPACITY * 3), 3));
    this.geometry.setAttribute("aLife", new THREE.BufferAttribute(this.life, 1));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uColor: { value: new THREE.Color(color) }, uScale: { value: 400 } },
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  emit(x: number, y: number, z: number, count: number): void {
    this.sim.emit(x, y, z, count);
    this.active = this.sim.alive();
    this.points.visible = true;
  }

  update(dt: number): void {
    if (this.active === 0) return;
    this.sim.step(dt);
    const pos = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const s = this.sim;
    for (let k = 0; k < DUST_CAPACITY; k++) {
      pos.setXYZ(k, s.px[k]!, s.py[k]!, s.pz[k]!);
      this.life[k] = Math.min(1, s.age[k]! / DUST_LIFE_S);
    }
    pos.needsUpdate = true;
    (this.geometry.getAttribute("aLife") as THREE.BufferAttribute).needsUpdate = true;
    this.active = s.alive();
    if (this.active === 0) this.points.visible = false;
  }

  dispose(scene: THREE.Object3D): void {
    scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}
