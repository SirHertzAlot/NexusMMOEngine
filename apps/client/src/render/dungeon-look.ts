/**
 * DungeonAmbience: how a dungeon run looks (roadmap D4c, D4e): dark fantasy, matte.
 *
 * The server sends a `look` once on entering (content/dungeons/looks.json, one
 * theme). While one applies, the sky, clouds, rain and sea are hidden, the scene
 * takes near-black exponential fog and a dim hemisphere and directional light, the
 * shell's material slots (floor, wall, ceiling, basin) take the theme's matte
 * palette (roughness 1, metalness 0, flat-shaded stone), and a small pool of point
 * lights burns on the nearest torches and braziers. Everything the run changed is
 * put back when the look goes (leaving the run), so the open world is unchanged.
 */

import * as THREE from "three";
import { fnv1a32 } from "@mmo-engine/picg";
import type { DungeonLook } from "@mmo-engine/protocol";

type Point = readonly [number, number, number];

/** Indices of the `n` points nearest `eye`, nearest first. */
export function nearest(points: readonly Point[], eye: { x: number; y: number; z: number }, n: number): number[] {
  const d = points.map((p, i) => ({ i, d: (p[0] - eye.x) ** 2 + (p[1] - eye.y) ** 2 + (p[2] - eye.z) ** 2 }));
  d.sort((a, b) => a.d - b.d);
  return d.slice(0, Math.max(0, n)).map((e) => e.i);
}

const key = (p: Point): string => `${p[0].toFixed(2)},${p[1].toFixed(2)},${p[2].toFixed(2)}`;
/** The colour a slot has until a look names it: stone grey. */
const STONE = "#2a2a2c";
/** How often the lights re-pick the nearest emitters, seconds; how fast an intensity follows its target, per second. */
const REPICK_S = 0.2;
const FOLLOW = 6;

interface Burning {
  light: THREE.PointLight;
  /** The emitter it sits on (its position key), or null: out. */
  on: string | null;
  /** 0..1, eased toward 1 on an emitter and 0 off one: no popping as the nearest set changes. */
  level: number;
  phase: number;
}

export class DungeonAmbience {
  private look: DungeonLook | null = null;
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 0);
  private readonly dir = new THREE.DirectionalLight(0xffffff, 0);
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private burning: Burning[] = [];
  private saved: { fog: THREE.Scene["fog"]; background: THREE.Scene["background"]; hidden: boolean[] } | null = null;
  private lastPick = -Infinity;
  private lastSeconds = 0;
  private hashes: ReadonlySet<number> = new Set();

  private readonly hide: THREE.Object3D[] = [];

  constructor(private readonly scene: THREE.Scene) {
    this.dir.position.set(2, 10, 3);
  }

  /** What a run has no use for (sky, clouds, rain, sea): hidden while a look applies, shown again after. */
  hideWhileLit(...objects: THREE.Object3D[]): void {
    this.hide.push(...objects);
  }

  /** The AssetRef hashes of the assets that give light in this run. */
  get emitterHashes(): ReadonlySet<number> {
    return this.hashes;
  }

  /** Apply `look` (null: put the open world back). Does nothing for the look already applied. */
  apply(look: DungeonLook | null): void {
    if (look === this.look) return;
    this.look = look;
    if (!look) {
      this.restore();
      return;
    }
    if (!this.saved) {
      this.saved = { fog: this.scene.fog, background: this.scene.background, hidden: this.hide.map((o) => o.visible) };
      this.scene.add(this.hemi, this.dir);
    }
    for (const o of this.hide) o.visible = false;
    this.scene.background = new THREE.Color(look.background);
    this.scene.fog = new THREE.FogExp2(new THREE.Color(look.fog.color).getHex(), look.fog.density);
    this.hemi.color.set(look.hemisphere.sky);
    this.hemi.groundColor.set(look.hemisphere.ground);
    this.hemi.intensity = look.hemisphere.intensity;
    this.dir.color.set(look.dir.color);
    this.dir.intensity = look.dir.intensity;
    for (const [slot, material] of this.materials) material.color.set(look.palette[slot] ?? STONE);
    this.hashes = new Set(look.emitters.map((a) => fnv1a32(a) >>> 0));
    this.rebuildLights(look);
  }

  /** The materials of a mesh's slots, by slot name: matte flat-shaded stone in the look's palette (live: a look that arrives later recolours them). */
  readonly materialFor = (slots: readonly string[]): THREE.Material[] => slots.map((s) => this.material(s));

  private material(slot: string): THREE.MeshStandardMaterial {
    let m = this.materials.get(slot);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: this.look?.palette[slot] ?? STONE, roughness: 1, metalness: 0, flatShading: true });
      this.materials.set(slot, m);
    }
    return m;
  }

  private rebuildLights(look: DungeonLook): void {
    for (const b of this.burning) {
      this.scene.remove(b.light);
      b.light.dispose();
    }
    this.burning = [];
    for (let i = 0; i < look.maxLights; i++) {
      const light = new THREE.PointLight(look.torch.color, 0, look.torch.range, 2);
      this.scene.add(light);
      this.burning.push({ light, on: null, level: 0, phase: i * 2.399 });
    }
    this.lastPick = -Infinity;
  }

  /**
   * Once a frame: keep the lights on the nearest `emitters` (positions of the torches and braziers),
   * easing them in and out, with a flicker. Re-picks a few times a second, not every frame.
   */
  update(eye: { x: number; y: number; z: number }, emitters: readonly Point[], seconds: number): void {
    const look = this.look;
    if (!look) return;
    const dt = Math.min(0.25, Math.max(0, seconds - this.lastSeconds));
    this.lastSeconds = seconds;
    if (seconds - this.lastPick >= REPICK_S) {
      this.lastPick = seconds;
      const chosen = nearest(emitters, eye, this.burning.length).map((i) => emitters[i]);
      const keep = new Set(chosen.map(key));
      // A light keeps its emitter while that one is still among the nearest; the rest go out and take a new one.
      for (const b of this.burning) if (b.on !== null && !keep.has(b.on)) b.on = null;
      const taken = new Set(this.burning.map((b) => b.on).filter((k): k is string => k !== null));
      for (const p of chosen) {
        if (taken.has(key(p))) continue;
        const free = this.burning.find((b) => b.on === null && b.level < 0.05) ?? this.burning.find((b) => b.on === null);
        if (!free) break;
        free.on = key(p);
        free.light.position.set(p[0], p[1] + 0.2, p[2]);
        taken.add(key(p));
      }
    }
    const ease = Math.min(1, dt * FOLLOW);
    for (const b of this.burning) {
      b.level += ((b.on === null ? 0 : 1) - b.level) * ease;
      const flicker = 1 - look.torch.flicker * (0.5 + 0.5 * Math.sin(seconds * 9.1 + b.phase) * Math.sin(seconds * 5.3 + b.phase * 1.7));
      b.light.intensity = look.torch.intensity * b.level * flicker;
    }
  }

  private restore(): void {
    for (const b of this.burning) {
      this.scene.remove(b.light);
      b.light.dispose();
    }
    this.burning = [];
    this.hashes = new Set();
    if (!this.saved) return;
    this.scene.remove(this.hemi, this.dir);
    this.scene.fog = this.saved.fog;
    this.scene.background = this.saved.background;
    this.hide.forEach((o, i) => (o.visible = this.saved!.hidden[i]));
    this.saved = null;
  }

  dispose(): void {
    this.look = null;
    this.restore();
    this.hemi.dispose();
    this.dir.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
  }
}
