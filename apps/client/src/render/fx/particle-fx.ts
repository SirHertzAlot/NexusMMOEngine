/**
 * ParticleFx — weather and splashes, with three-nebula.
 *
 * - Weather: one emitter per kind (snow, rain, ash) that follows the camera
 *   and spawns in a box above it; particles live in world space, so they
 *   fall past the camera instead of travelling with it. Its rate fades
 *   toward the current weather's intensity over `fadeSeconds`, so a
 *   shower starts and stops gradually.
 * - Splashes: a one-off burst of droplets, e.g. where the player swims.
 *
 * Everything is drawn by nebula's GPURenderer: one point-sprite draw call
 * for all particles. The look is data (particles.json); nebula scales
 * forces by 100 (it was written for pixels), so gravity and drift are
 * divided by 100 here and stay in metres in the data.
 */

import * as THREE from "three";
import System, {
  Alpha,
  BoxZone,
  Color,
  Emitter,
  GPURenderer,
  Gravity,
  Life,
  Mass,
  Position,
  PointZone,
  RadialVelocity,
  Radius,
  RandomDrift,
  Rate,
  Span,
  Texture,
  Vector3D,
  VectorVelocity,
} from "three-nebula";
import presets from "./particles.json" with { type: "json" };
import type { Weather, WeatherKind, WeatherRules } from "./weather.js";
import { budgetForTier, DEFAULT_PARTICLE_BUDGETS, type QualityTier } from "@mmo-engine/art/browser";

/** nebula multiplies forces by this (pixels); our data is in metres. */
const NEBULA_FORCE_SCALE = 100;
const MAX_PARTICLES = 8000;
/** Emission step: nebula emits `count` particles every `EMIT_EVERY` seconds. */
const EMIT_EVERY = 0.05;

/** The tier budgets, validated at load. */
const BUDGETS = DEFAULT_PARTICLE_BUDGETS;

/**
 * The emission multiplier for a quality tier, from the budget file.
 * Ultra's budget is the renderer's native capacity (MAX_PARTICLES).
 */
export function budgetMultiplierForTier(tier: QualityTier): number {
  return budgetForTier(BUDGETS, tier).maxParticles / MAX_PARTICLES;
}

interface WeatherPreset {
  rate: number;
  life: number;
  fall: number;
  size: number;
  color: string;
  alpha: number;
  drift: number;
  area: [number, number, number];
  texture: "soft" | "streak";
}

interface SplashPreset {
  count: number;
  life: number;
  speed: number;
  spreadDeg: number;
  size: number;
  color: string;
  alpha: number;
  gravity: number;
  everySeconds: number;
}

export const WEATHER_RULES: WeatherRules = { biomes: presets.biomes as WeatherRules["biomes"], spellMinutes: presets.spellMinutes };
const WEATHER = presets.weather as Record<WeatherKind, WeatherPreset>;
const SPLASH = presets.splash as SplashPreset;
const FADE_SECONDS = presets.fadeSeconds;

/** A soft round dot (snow, ash, droplets). */
function softTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

/** A thin vertical streak (rain). */
function streakTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 32);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.5, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(15, 0, 2, 32);
  return new THREE.CanvasTexture(c);
}

interface WeatherEmitter {
  kind: WeatherKind;
  preset: WeatherPreset;
  emitter: Emitter;
  /** Current strength (0..1), easing toward the target. */
  level: number;
  /** The particle count per emission step the rate was last set to. */
  count: number;
}

export class ParticleFx {
  /** Where the particles are drawn: add it to the scene. */
  readonly group = new THREE.Group();
  private readonly system: System;
  private readonly textures: Record<"soft" | "streak", THREE.Texture>;
  private readonly weather: WeatherEmitter[] = [];
  private splashCooldown = 0;
  /** The quality preset's particle multiplier. */
  private budget = 1;
  private disposed = false;

  constructor(camera: THREE.Camera) {
    this.group.name = "particles";
    this.textures = { soft: softTexture(), streak: streakTexture() };
    this.system = new System();
    this.system.addRenderer(
      new GPURenderer(this.group, THREE, {
        camera,
        maxParticles: MAX_PARTICLES,
        blending: "NormalBlending",
        transparent: true,
        depthWrite: false,
        depthTest: true,
        baseColor: 0xffffff,
        // three >= 0.163 is WebGL2-only, which always has the float textures
        // the desktop renderer needs: skip nebula's probe canvas.
        shouldForceDesktopRenderer: true,
      }),
    );
    for (const kind of Object.keys(WEATHER) as WeatherKind[]) {
      const preset = WEATHER[kind];
      const emitter = new Emitter();
      emitter.damping = 0;
      const [w, h, d] = preset.area;
      emitter
        .setRate(new Rate(new Span(0, 0), new Span(EMIT_EVERY)))
        .setInitializers([
          new Position(new BoxZone(0, h / 2, 0, w, h, d)),
          new Mass(1),
          new Radius(preset.size * 0.7, preset.size * 1.3),
          new Life(preset.life * 0.8, preset.life * 1.2),
          new VectorVelocity(new Vector3D(0, -preset.fall, 0), 4),
          new Texture(THREE, this.textures[preset.texture]),
        ])
        .setBehaviours([
          new Alpha(preset.alpha, preset.alpha * 0.8),
          new Color(preset.color, preset.color),
          new RandomDrift(preset.drift / NEBULA_FORCE_SCALE, 0, preset.drift / NEBULA_FORCE_SCALE, 0.4),
        ])
        .emit();
      this.system.addEmitter(emitter);
      this.weather.push({ kind, preset, emitter, level: 0, count: 0 });
    }
  }

  /** Scale every emission by the quality preset's particle budget (1 as designed). */
  setBudget(multiplier: number): void {
    this.budget = Math.max(0, multiplier);
  }

  /** Particles alive now (tests, HUD). */
  get count(): number {
    return this.system.getCount();
  }

  /** Strength of each kind of weather now (0..1), after fading. */
  levels(): Record<WeatherKind, number> {
    const out = {} as Record<WeatherKind, number>;
    for (const w of this.weather) out[w.kind] = w.level;
    return out;
  }

  /**
   * Once per frame: fade the weather toward `weather`, keep it around the
   * camera, and advance every particle by `dt` seconds.
   */
  update(dt: number, cameraPos: THREE.Vector3, weather: Weather): void {
    if (this.disposed) return;
    const step = Math.min(1, dt / FADE_SECONDS);
    for (const w of this.weather) {
      const target = weather.kind === w.kind ? weather.intensity : 0;
      w.level += Math.sign(target - w.level) * Math.min(Math.abs(target - w.level), step);
      // Rate changes only when the particle count per step actually changes.
      const count = Math.round(w.preset.rate * w.level * EMIT_EVERY * Math.min(this.budget, MAX_PARTICLES / (w.preset.rate * w.preset.life * 1.2)));
      if (count !== w.count) {
        w.count = count;
        w.emitter.setRate(new Rate(new Span(count, count), new Span(EMIT_EVERY)));
      }
      w.emitter.setPosition({ x: cameraPos.x, y: cameraPos.y + 6, z: cameraPos.z });
    }
    this.splashCooldown = Math.max(0, this.splashCooldown - dt);
    void this.system.update(dt);
  }

  /**
   * A burst of droplets at `at` (e.g. the water surface where the player
   * swims). Rate-limited to one per `everySeconds` unless `force`.
   */
  splash(at: THREE.Vector3, force = false): boolean {
    if (this.disposed || (!force && this.splashCooldown > 0)) return false;
    this.splashCooldown = SPLASH.everySeconds;
    const splashCount = Math.max(1, Math.round(SPLASH.count * this.budget));
    const emitter = new Emitter();
    emitter.damping = 0;
    emitter
      .setRate(new Rate(new Span(splashCount, splashCount), new Span(1)))
      .setInitializers([
        new Position(new PointZone(0, 0, 0)),
        new Mass(1),
        new Radius(SPLASH.size * 0.6, SPLASH.size * 1.4),
        new Life(SPLASH.life * 0.6, SPLASH.life),
        new RadialVelocity(new Span(SPLASH.speed * 0.5, SPLASH.speed), new Vector3D(0, 1, 0), SPLASH.spreadDeg),
        new Texture(THREE, this.textures.soft),
      ])
      .setBehaviours([
        new Alpha(SPLASH.alpha, 0),
        new Color(SPLASH.color, SPLASH.color),
        new Gravity(SPLASH.gravity / NEBULA_FORCE_SCALE),
      ])
      .setPosition({ x: at.x, y: at.y, z: at.z })
      // A finite life: nebula removes the emitter once it has passed and its droplets are gone.
      .emit("once", SPLASH.life);
    this.system.addEmitter(emitter);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.system.destroy();
    this.group.removeFromParent();
    this.textures.soft.dispose();
    this.textures.streak.dispose();
  }
}
