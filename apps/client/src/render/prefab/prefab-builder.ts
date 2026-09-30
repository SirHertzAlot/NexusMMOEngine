/**
 * PrefabBuilder — a composed entity (@mmo-engine/compose) made visible: its
 * bundle's `Prefab` applied to the base Object3D it names (a species'
 * character, an item's mesh), so the rank and element show on the model.
 *
 * - material: the item's material colour, on its base mesh (iron grey,
 *   obsidian black, a ruby's red)
 * - tint: the element's (or rank's) colour mixed into every surface
 * - particles and aura: three.quarks effects that follow the entity
 *   (vfx/quarks-fx.ts)
 * - runes: a slowly turning ring of glowing glyphs at the feet, drawn by a
 *   procedural shader (no textures)
 * - transform: body changes from the top ranks: a larger or broader frame,
 *   a spectral translucency and float, an item's hover and spin, ornate
 *   filigree (a rank-coloured glow on its edges)
 *
 * Materials are cloned before they're changed, so shared ones (the kit's,
 * a prop pack's) are never altered; `dispose()` undoes everything and
 * leaves the base as it was.
 */

import * as THREE from "three";
import type { EntityBundle, PrefabAttachment } from "@mmo-engine/compose/browser";
import type { QuarksFx, VfxHandle } from "../vfx/quarks-fx.js";

export interface PrefabInstance {
  /** Holds the base and everything attached: place this in the scene. */
  readonly root: THREE.Group;
  /** Once a frame (runes turn, items hover and spin, spectral forms bob). */
  update(dt: number, time: number): void;
  dispose(): void;
}

const RUNES_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// A band of angular glyphs: each cell of the ring holds strokes chosen by a
// hash, pulsing gently.
const RUNES_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
varying vec2 vUv;
float hash(float n) { return fract(sin(n * 91.345) * 47453.53); }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float band = smoothstep(0.62, 0.66, r) * (1.0 - smoothstep(0.9, 0.94, r));
  float a = atan(p.y, p.x) / 6.28318 + 0.5;
  float cells = 18.0;
  float cell = floor(a * cells);
  vec2 q = vec2(fract(a * cells), (r - 0.66) / 0.24);
  float glyph = 0.0;
  for (int i = 0; i < 4; i++) {
    float h = hash(cell * 7.0 + float(i));
    float x = 0.2 + 0.6 * hash(cell * 13.0 + float(i) * 3.0);
    float stroke = h > 0.5
      ? 1.0 - smoothstep(0.04, 0.08, abs(q.x - x))
      : 1.0 - smoothstep(0.04, 0.08, abs(q.y - x));
    glyph = max(glyph, stroke * step(0.15, q.y) * step(q.y, 0.85) * step(0.1, q.x) * step(q.x, 0.9));
  }
  float edge = (1.0 - smoothstep(0.0, 0.02, abs(r - 0.64))) + (1.0 - smoothstep(0.0, 0.02, abs(r - 0.92)));
  float pulse = 0.75 + 0.25 * sin(uTime * 2.0 + cell);
  float alpha = (glyph * band * pulse + edge * 0.6);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(uColor * 1.6, alpha);
}
`;

const tmpBox = new THREE.Box3();
const tmpSize = new THREE.Vector3();

/** The base's footprint radius and height (for rings and auras). */
function extentOf(base: THREE.Object3D): { radius: number; height: number } {
  tmpBox.setFromObject(base);
  if (tmpBox.isEmpty()) return { radius: 0.6, height: 1.8 };
  tmpBox.getSize(tmpSize);
  return { radius: Math.max(0.4, Math.max(tmpSize.x, tmpSize.z) / 2), height: Math.max(0.2, tmpSize.y) };
}

/**
 * A copy to change freely. Subclasses with their own constructors (the
 * character material) can't `clone()`: copy them into their built-in
 * three.js class instead, keeping their shader patch (toon, recolour),
 * whose uniforms stay shared with the original.
 */
export function cloneMaterial(m: THREE.Material): THREE.Material {
  const builtin = (THREE as unknown as Record<string, unknown>)[m.type] as (new () => THREE.Material) | undefined;
  const c = builtin && m.constructor !== builtin ? new builtin().copy(m) : m.clone();
  c.onBeforeCompile = m.onBeforeCompile;
  c.customProgramCacheKey = m.customProgramCacheKey;
  return c;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);

export class PrefabBuilder {
  constructor(private readonly vfx: QuarksFx | null) {}

  /** Apply a bundle's prefab to `base` (which the instance then owns the placement of). */
  build(bundle: Pick<EntityBundle, "Prefab" | "Rank" | "Identity">, base: THREE.Object3D): PrefabInstance {
    const root = new THREE.Group();
    root.name = `prefab:${bundle.Identity.name}`;
    const body = new THREE.Group(); // transforms (scale, hover) apply here, not to the placed root
    body.add(base);
    root.add(body);
    const undo: Array<() => void> = [];
    const effects: VfxHandle[] = [];
    const tickers: Array<(dt: number, time: number) => void> = [];
    const extent = extentOf(base);

    // Materials we change are clones; the originals come back on dispose.
    const clones = new Map<THREE.Material, THREE.Material>();
    const own = (): THREE.Material[] => {
      const out: THREE.Material[] = [];
      base.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const swap = (m: THREE.Material): THREE.Material => {
          let c = clones.get(m);
          if (!c) {
            c = cloneMaterial(m);
            clones.set(m, c);
            out.push(c);
          }
          return c;
        };
        const before = mesh.material;
        mesh.material = Array.isArray(before) ? before.map(swap) : swap(before);
        undo.push(() => (mesh.material = before));
      });
      return [...clones.values()];
    };
    let materials: THREE.Material[] | null = null;
    const mats = (): THREE.MeshStandardMaterial[] =>
      (materials ??= own()).filter((m): m is THREE.MeshStandardMaterial => (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true);

    if (bundle.Prefab.color) for (const m of mats()) m.color.multiply(new THREE.Color(bundle.Prefab.color));

    for (const a of bundle.Prefab.attach) {
      this.apply(a, { root, body, extent, mats, effects, tickers, rankColor: bundle.Rank.color });
    }

    return {
      root,
      update: (dt, time) => {
        for (const t of tickers) t(dt, time);
      },
      dispose: () => {
        for (const e of effects) e.dispose();
        for (const u of undo) u();
        for (const c of clones.values()) c.dispose();
        root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.userData.prefabOwned) {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
          }
        });
        body.remove(base);
        root.removeFromParent();
      },
    };
  }

  private apply(
    a: PrefabAttachment,
    c: {
      root: THREE.Group;
      body: THREE.Group;
      extent: { radius: number; height: number };
      mats: () => THREE.MeshStandardMaterial[];
      effects: VfxHandle[];
      tickers: Array<(dt: number, time: number) => void>;
      rankColor: string;
    },
  ): void {
    switch (a.kind) {
      case "particles":
      case "aura": {
        if (!this.vfx) return;
        const radius = a.kind === "aura" ? num(a.params.radius, 1.2) * Math.max(0.6, c.extent.radius) : c.extent.radius;
        const h = this.vfx.attachSignal({ ...a, params: { ...a.params, radius } }, c.root);
        if (h) {
          // Particles rise from mid-body; the aura sits at the feet.
          if (a.kind === "particles") h.system.emitter.position.y = c.extent.height * 0.5;
          c.effects.push(h);
        }
        return;
      }
      case "tint": {
        const color = new THREE.Color(str(a.params.color) ?? c.rankColor);
        const amount = num(a.params.amount, 0.3);
        for (const m of c.mats()) {
          m.color.lerp(color, amount);
          m.emissive.lerp(color, amount * 0.25);
        }
        return;
      }
      case "runes": {
        const size = c.extent.radius * 3;
        const uniforms = { uColor: { value: new THREE.Color(str(a.params.color) ?? c.rankColor) }, uTime: { value: 0 } };
        const ring = new THREE.Mesh(
          new THREE.PlaneGeometry(size, size),
          new THREE.ShaderMaterial({
            vertexShader: RUNES_VERTEX,
            fragmentShader: RUNES_FRAGMENT,
            uniforms,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
          }),
        );
        ring.name = "runes";
        ring.userData.prefabOwned = true;
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.03;
        ring.raycast = () => {};
        c.root.add(ring);
        c.tickers.push((_dt, time) => {
          uniforms.uTime.value = time;
          ring.rotation.z = time * 0.15;
        });
        return;
      }
      case "transform": {
        const scale = num(a.params.scale, 1);
        const girth = num(a.params.girth, 1);
        c.body.scale.set(scale * girth, scale, scale * girth);
        const opacity = num(a.params.opacity, 1);
        if (opacity < 1) {
          for (const m of c.mats()) {
            m.transparent = true;
            m.opacity = opacity;
            m.depthWrite = false;
          }
        }
        if (a.params.gait === "float") c.tickers.push((_dt, time) => (c.body.position.y = 0.25 + Math.sin(time * 1.6) * 0.08));
        const hover = num(a.params.hover, 0);
        const spin = num(a.params.spin, 0);
        if (hover || spin) {
          c.tickers.push((_dt, time) => {
            c.body.position.y = hover + Math.sin(time * 2) * hover * 0.3;
            c.body.rotation.y = time * spin * Math.PI * 2;
          });
        }
        if (a.params.filigree) {
          const glow = new THREE.Color(c.rankColor);
          for (const m of c.mats()) m.emissive.lerp(glow, 0.35);
        }
        return;
      }
    }
  }
}
