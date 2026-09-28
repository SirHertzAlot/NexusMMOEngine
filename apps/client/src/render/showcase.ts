/**
 * FX showcase — toggles a ring of the six elemental orbs around the
 * player so the FX can be inspected live in the client.
 *
 * Strictly visual and local: the orbs are decorative preview objects,
 * not authoritative entities (the server never hears about them).
 */

import * as THREE from "three";
import {
  ELEMENTS,
  makeElementMaterial,
  tickElementMaterial,
  glowTexture,
  labelSprite,
  type ElementKind,
} from "./element-fx.js";

const ORB_BURST_COLOR: Record<ElementKind, number> = {
  water: 0x33aaff,
  fire: 0xff6622,
  wind: 0xaaddff,
  earth: 0xcc9955,
  snow: 0xddf0ff,
  lava: 0xff4400,
};

interface Orb {
  group: THREE.Group;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  kind: ElementKind;
  phase: number;
  baseY: number;
}

export class FxShowcase {
  private readonly group = new THREE.Group();
  private readonly orbs: Orb[] = [];
  private visible = false;
  private pulseTimer = 0;
  private pulseIndex = 0;

  /**
   * @param onPulse fired periodically at a random orb's position so the
   *   showcase can demo spawn-burst FX in each element's color.
   */
  constructor(
    private readonly scene: THREE.Scene,
    private readonly onPulse?: (pos: THREE.Vector3, color: number) => void,
  ) {
    this.group.visible = false;
    const radius = 5.5;
    ELEMENTS.forEach((kind, i) => {
      const angle = (i / ELEMENTS.length) * Math.PI * 2;
      const mat = makeElementMaterial(kind);
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.7, 48, 32), mat);
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture(),
          color: ORB_BURST_COLOR[kind],
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      halo.scale.set(2.8, 2.8, 1);
      const label = labelSprite(kind.toUpperCase());
      label.position.y = 1.75;
      label.scale.multiplyScalar(1.15);
      const g = new THREE.Group();
      g.add(orb, halo, label);
      const baseY = 1.7;
      g.position.set(Math.cos(angle) * radius, baseY, Math.sin(angle) * radius);
      this.group.add(g);
      this.orbs.push({ group: g, mesh: orb, mat, kind, phase: (i / ELEMENTS.length) * Math.PI * 2, baseY });
    });
    scene.add(this.group);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Show/hide; when shown, centers the ring on `center`. */
  setVisible(v: boolean, center?: THREE.Vector3): void {
    this.visible = v;
    this.group.visible = v;
    if (v && center) this.group.position.set(center.x, 0, center.z);
  }

  update(time: number, dt: number): void {
    if (!this.visible) return;
    for (const o of this.orbs) {
      tickElementMaterial(o.mat, time + o.phase);
      o.group.position.y = o.baseY + Math.sin(time * 1.3 + o.phase) * 0.35;
      // Spin the orb mesh only — labels stay pinned above their orb.
      o.mesh.rotation.y = time * 0.4 + o.phase;
    }
    // Every ~2.2s, pulse a spawn burst in the next orb's element color.
    this.pulseTimer += dt;
    if (this.pulseTimer >= 2.2 && this.onPulse) {
      this.pulseTimer = 0;
      const o = this.orbs[this.pulseIndex % this.orbs.length];
      this.pulseIndex++;
      const p = new THREE.Vector3();
      o.group.getWorldPosition(p);
      p.y = 0;
      this.onPulse(p, ORB_BURST_COLOR[o.kind]);
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      (mesh.geometry as THREE.BufferGeometry | undefined)?.dispose();
      const mat = mesh.material as THREE.Material | undefined;
      mat?.dispose();
    });
    this.orbs.length = 0;
  }
}
