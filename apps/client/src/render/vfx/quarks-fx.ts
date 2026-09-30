/**
 * QuarksFx — attached particle effects on three.quarks: the particles and
 * auras the entity composer's signals name, and weapon trails.
 *
 * Every system goes through one BatchedRenderer (systems that share a
 * material draw in one call). Effects follow an Object3D: a creature's
 * root, a weapon socket, an orb. Particles live in world space, so embers
 * stay where they rose as their owner walks on.
 *
 * - `attachSignal(signal, target)` takes a composer prefab attachment
 *   (`{ kind, id, params }` from @mmo-engine/compose) and starts its effect:
 *   "particles" by effect id (embers, snow, sparks, spores, motes, smoke,
 *   void-wisps, glimmer), and "aura" as a ring of light at the feet that
 *   rises and turns, in the aura's colour and radius. Other signals (runes,
 *   tints, transforms) aren't particles: it returns null for them.
 * - `attachTrail(target, …)` draws a ribbon behind a moving socket (a
 *   blade's tip): the trail is emitted by distance, so it only shows while
 *   the socket moves.
 *
 * The quality preset's particle budget scales every emission rate.
 */

import * as THREE from "three";
import {
  ApplyForce,
  BatchedRenderer,
  Bezier,
  ColorOverLife,
  ConeEmitter,
  ConstantColor,
  ConstantValue,
  DonutEmitter,
  Gradient,
  IntervalValue,
  Noise,
  OrbitOverLife,
  ParticleSystem,
  PiecewiseBezier,
  RenderMode,
  SizeOverLife,
  SphereEmitter,
  Vector3 as QVector3,
  Vector4 as QVector4,
  WidthOverLength,
  type Behavior,
  type EmitterShape,
  type TrailSettings,
} from "three.quarks";

/** A composer prefab attachment (see @mmo-engine/compose PrefabAttachment). */
export interface SignalAttachment {
  kind: string;
  id: string;
  params: Record<string, number | string | boolean>;
}

export interface ParticlePreset {
  /** Start and end colour (sRGB hex). */
  color: [string, string];
  /** Opacity at birth, peak and death. */
  alpha: [number, number, number];
  size: [number, number];
  life: [number, number];
  speed: [number, number];
  /** Particles a second (before the quality budget). */
  rate: number;
  shape: "sphere" | "cone" | "ring";
  /** Emitter radius (m), scaled by the signal's radius when given. */
  radius: number;
  /** Upward (+) or downward (−) acceleration, m/s². */
  lift: number;
  /** Wander (noise power). */
  wander: number;
  /** Turns about the owner (radians a second). */
  orbit?: number;
  blending: "additive" | "normal";
  texture: "soft" | "spark";
}

/** The composer's particle effects, by id (catalog `params.effect`). */
export const PARTICLE_PRESETS: Record<string, ParticlePreset> = {
  embers: { color: ["#ffb347", "#ff3b0a"], alpha: [0, 1, 0], size: [0.05, 0.12], life: [1.2, 2.2], speed: [0.2, 0.6], rate: 18, shape: "sphere", radius: 0.6, lift: 1.2, wander: 0.6, blending: "additive", texture: "spark" },
  snow: { color: ["#ffffff", "#cfe9ff"], alpha: [0, 0.9, 0], size: [0.05, 0.1], life: [1.5, 2.5], speed: [0.05, 0.2], rate: 16, shape: "sphere", radius: 0.9, lift: -0.4, wander: 0.4, orbit: 0.8, blending: "normal", texture: "soft" },
  sparks: { color: ["#e6e0ff", "#7f6bff"], alpha: [1, 1, 0], size: [0.03, 0.06], life: [0.2, 0.45], speed: [1.5, 3], rate: 22, shape: "sphere", radius: 0.5, lift: 0, wander: 2, blending: "additive", texture: "spark" },
  spores: { color: ["#c8ff8a", "#5fbf4a"], alpha: [0, 0.8, 0], size: [0.04, 0.09], life: [2, 3.5], speed: [0.05, 0.2], rate: 10, shape: "sphere", radius: 0.9, lift: 0.15, wander: 0.5, blending: "additive", texture: "soft" },
  motes: { color: ["#fff6c8", "#ffd66b"], alpha: [0, 1, 0], size: [0.05, 0.1], life: [1.5, 2.5], speed: [0.05, 0.15], rate: 12, shape: "sphere", radius: 0.8, lift: 0.35, wander: 0.2, orbit: 0.6, blending: "additive", texture: "soft" },
  smoke: { color: ["#4a3c5a", "#15121a"], alpha: [0, 0.55, 0], size: [0.35, 0.7], life: [1.8, 3], speed: [0.1, 0.3], rate: 8, shape: "sphere", radius: 0.5, lift: 0.5, wander: 0.3, blending: "normal", texture: "soft" },
  "void-wisps": { color: ["#9b6bff", "#1b0b3a"], alpha: [0, 0.9, 0], size: [0.08, 0.16], life: [1.2, 2], speed: [0.1, 0.3], rate: 14, shape: "sphere", radius: 0.7, lift: -0.1, wander: 0.8, orbit: -1.2, blending: "additive", texture: "soft" },
  glimmer: { color: ["#ffffff", "#bfe6ff"], alpha: [0, 1, 0], size: [0.03, 0.07], life: [0.6, 1.2], speed: [0, 0.05], rate: 10, shape: "sphere", radius: 0.7, lift: 0, wander: 0, blending: "additive", texture: "spark" },
};

/** The aura: a ring of light at the feet, rising and turning, in the signal's colour. */
const AURA: ParticlePreset = {
  color: ["#ffffff", "#ffffff"], alpha: [0, 0.8, 0], size: [0.12, 0.22], life: [1, 1.6], speed: [0, 0.05], rate: 30, shape: "ring", radius: 1.2, lift: 0.9, wander: 0.1, orbit: 1.4, blending: "additive", texture: "soft",
};

export interface VfxHandle {
  readonly system: ParticleSystem;
  dispose(): void;
}

const hexToLinear = (hex: string): THREE.Color => new THREE.Color(hex);
const v4 = (c: THREE.Color, a: number): QVector4 => new QVector4(c.r, c.g, c.b, a);
const v3 = (c: THREE.Color): QVector3 => new QVector3(c.r, c.g, c.b);

/** A round, soft-edged (or a sharper, hotter) dot, as data: no canvas, so it works anywhere. */
function dotTexture(kind: "soft" | "spark"): THREE.DataTexture {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
      const a = kind === "soft" ? Math.max(0, 1 - d) ** 2 : Math.max(0, 1 - d) ** 4 + (d < 0.25 ? 0.6 : 0);
      const o = (y * n + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export class QuarksFx {
  /** Add this to the scene: it draws every effect. */
  readonly renderer = new BatchedRenderer();
  private readonly textures = { soft: dotTexture("soft"), spark: dotTexture("spark") };
  private readonly materials = new Map<string, THREE.MeshBasicMaterial>();
  /** Every live system and its designed emission rate (the budget scales it). */
  private readonly live = new Map<ParticleSystem, number>();
  private budget = 1;

  constructor() {
    this.renderer.name = "quarks-fx";
  }

  /** Scale every emission by the quality preset's particle budget (1 as designed). */
  setBudget(multiplier: number): void {
    this.budget = Math.max(0, multiplier);
    for (const [system, rate] of this.live) system.emissionOverTime = new ConstantValue(rate * this.budget);
  }

  /** Systems running now (tests, HUD). */
  get systems(): number {
    return this.live.size;
  }

  /** Start a composer signal's effect on `target` (null: that signal isn't a particle effect). */
  attachSignal(signal: SignalAttachment, target: THREE.Object3D): VfxHandle | null {
    const radius = typeof signal.params.radius === "number" ? signal.params.radius : null;
    const color = typeof signal.params.color === "string" ? signal.params.color : null;
    if (signal.kind === "aura") {
      const c = color ?? "#c080ff";
      return this.attach({ ...AURA, color: [c, c], radius: radius ?? AURA.radius }, target);
    }
    if (signal.kind === "particles") {
      const id = typeof signal.params.effect === "string" ? signal.params.effect : signal.id;
      const preset = PARTICLE_PRESETS[id];
      if (!preset) return null;
      return this.attach(radius ? { ...preset, radius: preset.radius * radius } : preset, target);
    }
    return null;
  }

  /** A particle effect from a preset, following `target`. */
  attach(p: ParticlePreset, target: THREE.Object3D): VfxHandle {
    const [c0, c1] = [hexToLinear(p.color[0]), hexToLinear(p.color[1])];
    const shape: EmitterShape =
      p.shape === "cone"
        ? new ConeEmitter({ radius: p.radius, angle: Math.PI / 8 })
        : p.shape === "ring"
          ? new DonutEmitter({ radius: p.radius, donutRadius: 0.05, arc: Math.PI * 2 })
          : new SphereEmitter({ radius: p.radius, thickness: 1 });
    const behaviors: Behavior[] = [
      new ColorOverLife(new Gradient([[v3(c0), 0], [v3(c1), 1]], [[p.alpha[0], 0], [p.alpha[1], 0.25], [p.alpha[2], 1]])),
      new SizeOverLife(new PiecewiseBezier([[new Bezier(0.6, 1, 1, 0.8), 0]])),
    ];
    if (p.lift) behaviors.push(new ApplyForce(new QVector3(0, Math.sign(p.lift), 0), new ConstantValue(Math.abs(p.lift))));
    if (p.wander) behaviors.push(new Noise(new ConstantValue(1.5), new ConstantValue(p.wander)));
    if (p.orbit) behaviors.push(new OrbitOverLife(new ConstantValue(p.orbit), new QVector3(0, 1, 0)));
    const system = new ParticleSystem({
      looping: true,
      duration: 5,
      worldSpace: true,
      shape,
      startLife: new IntervalValue(p.life[0], p.life[1]),
      startSpeed: new IntervalValue(p.speed[0], p.speed[1]),
      startSize: new IntervalValue(p.size[0], p.size[1]),
      startColor: new ConstantColor(v4(c0, 1)),
      emissionOverTime: new ConstantValue(p.rate * this.budget),
      material: this.material(p),
      renderMode: RenderMode.BillBoard,
      behaviors,
    });
    // A ring at the feet: turned to lie flat on the ground.
    if (p.shape === "ring") system.emitter.rotation.x = -Math.PI / 2;
    return this.start(system, target, p.rate);
  }

  /**
   * A trail behind a moving socket (a blade's tip, a projectile): a ribbon
   * `width` metres wide at the socket, tapering to nothing over its last
   * `points` positions (one a frame), in `color`. One long-lived head
   * particle pinned to the socket records the history.
   */
  attachTrail(target: THREE.Object3D, color = "#9fe0ff", width = 0.12, points = 20): VfxHandle {
    const c = hexToLinear(color);
    const settings: TrailSettings = { startLength: new ConstantValue(points), followLocalOrigin: true };
    const system = new ParticleSystem({
      looping: false,
      duration: 1e6,
      worldSpace: true,
      shape: new SphereEmitter({ radius: 1e-4, thickness: 1 }),
      startLife: new ConstantValue(1e6),
      startSpeed: new ConstantValue(0),
      startSize: new ConstantValue(width),
      startColor: new ConstantColor(v4(c, 0.9)),
      emissionOverTime: new ConstantValue(0),
      emissionBursts: [{ time: 0, count: new ConstantValue(1), cycle: 1, interval: 0, probability: 1 }],
      material: this.material({ blending: "additive", texture: "soft" }),
      renderMode: RenderMode.Trail,
      rendererEmitterSettings: settings,
      behaviors: [new WidthOverLength(new PiecewiseBezier([[new Bezier(1, 0.66, 0.33, 0), 0]]))],
    });
    return this.start(system, target, 0);
  }

  /** Once a frame. */
  update(dt: number): void {
    this.renderer.update(dt);
  }

  dispose(): void {
    for (const system of [...this.live.keys()]) this.stop(system);
    for (const m of this.materials.values()) m.dispose();
    this.textures.soft.dispose();
    this.textures.spark.dispose();
    this.renderer.removeFromParent();
  }

  private start(system: ParticleSystem, target: THREE.Object3D, rate: number): VfxHandle {
    target.add(system.emitter);
    this.renderer.addSystem(system);
    this.live.set(system, rate);
    return { system, dispose: () => this.stop(system) };
  }

  private stop(system: ParticleSystem): void {
    if (!this.live.delete(system)) return;
    system.emitter.removeFromParent();
    this.renderer.deleteSystem(system);
    system.dispose();
  }

  /** One material per look, shared, so systems batch. */
  private material(p: Pick<ParticlePreset, "blending" | "texture">): THREE.MeshBasicMaterial {
    const key = `${p.blending}:${p.texture}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        map: this.textures[p.texture],
        transparent: true,
        depthWrite: false,
        blending: p.blending === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending,
        side: THREE.DoubleSide,
      });
      this.materials.set(key, m);
    }
    return m;
  }
}
