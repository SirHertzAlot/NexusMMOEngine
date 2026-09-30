/**
 * FX showcase — toggles a ring of the six elemental orbs around the
 * player so the FX can be inspected live in the client.
 *
 * With a QuarksFx, each orb also wears one of the entity composer's
 * signal effects (particles and an aura in its colour), a blade tip
 * circles the ring drawing a trail, and a row of composed legendary and
 * epic creatures and items (prefab/gallery.ts) stands behind the ring.
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
import type { QuarksFx, VfxHandle } from "./vfx/quarks-fx.js";
import { PrefabGallery } from "./prefab/gallery.js";

/** The composer signal each orb wears in the showcase. */
const ORB_SIGNALS: Record<ElementKind, { particles: string; aura: string }> = {
  water: { particles: "motes", aura: "#4fb4ff" },
  fire: { particles: "embers", aura: "#ff6a1a" },
  wind: { particles: "sparks", aura: "#b9a8ff" },
  earth: { particles: "spores", aura: "#6fd36a" },
  snow: { particles: "snow", aura: "#8fd8ff" },
  lava: { particles: "smoke", aura: "#ff4400" },
};

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
    private readonly vfx?: QuarksFx,
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

  private readonly blade = new THREE.Object3D();
  private effects: VfxHandle[] = [];
  private gallery: PrefabGallery | null = null;

  get isVisible(): boolean {
    return this.visible;
  }

  /** Show/hide; when shown, centers the ring on `center`. */
  setVisible(v: boolean, center?: THREE.Vector3): void {
    this.visible = v;
    this.group.visible = v;
    if (v && center) this.group.position.set(center.x, 0, center.z);
    // The composer's signal effects on the orbs, and a blade trail round the ring, while shown.
    for (const e of this.effects) e.dispose();
    this.effects = [];
    this.gallery?.dispose();
    this.gallery = null;
    if (v && this.vfx) {
      for (const o of this.orbs) {
        const s = ORB_SIGNALS[o.kind];
        const p = this.vfx.attachSignal({ kind: "particles", id: s.particles, params: { effect: s.particles } }, o.group);
        const a = this.vfx.attachSignal({ kind: "aura", id: `aura-${o.kind}`, params: { color: s.aura, radius: 0.9 } }, o.group);
        for (const h of [p, a]) if (h) this.effects.push(h);
      }
      if (!this.blade.parent) this.group.add(this.blade);
      this.effects.push(this.vfx.attachTrail(this.blade, "#9fe0ff", 0.18, 24));
      this.gallery = new PrefabGallery(this.vfx, labelSprite);
      this.group.add(this.gallery.group);
    }
  }

  update(time: number, dt: number): void {
    if (!this.visible) return;
    // The blade tip sweeps round inside the ring, rising and falling like a swing.
    this.blade.position.set(Math.cos(time * 2.2) * 3, 1.5 + Math.sin(time * 4.4) * 0.6, Math.sin(time * 2.2) * 3);
    this.gallery?.update(dt, time);
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
    for (const e of this.effects) e.dispose();
    this.effects = [];
    this.gallery?.dispose();
    this.gallery = null;
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
