/**
 * Pure helpers behind the VFX workspace (EA22): the particle preview's
 * simulation (the same emission rule the client uses under a tier's
 * multiplier and live-particle cap), colour conversions for the material
 * editors, and the toon shading the material preview paints.
 */
import type { ParticleEffect, Rgb, SplashEffect, TierPreset, WeatherEffect } from "@mmo-engine/art/browser";

/** Particles a second the client emits for `rate` under a tier: the multiplier, held under the live-particle cap. */
export function emissionRate(rate: number, meanLife: number, tier: Pick<TierPreset, "particles"> & { cap: number }): number {
  return Math.min(rate * tier.particles, tier.cap / Math.max(1e-6, meanLife));
}

export interface Dot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
}

/** A tiny deterministic generator, so a preview looks the same each run. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** What a preview emits: world metres, y up, centred on x = 0. */
export type PreviewKind =
  | { kind: "effect"; effect: ParticleEffect }
  | { kind: "weather"; weather: WeatherEffect }
  | { kind: "splash"; splash: SplashEffect };

export function previewLife(p: PreviewKind): number {
  return p.kind === "effect" ? (p.effect.life[0] + p.effect.life[1]) / 2 : p.kind === "weather" ? p.weather.life : p.splash.life;
}

export function previewRate(p: PreviewKind): number {
  return p.kind === "effect" ? p.effect.rate : p.kind === "weather" ? p.weather.rate : p.splash.count / p.splash.everySeconds;
}

export class ParticlePreview {
  dots: Dot[] = [];
  private carry = 0;
  private readonly rand: () => number;

  constructor(private p: PreviewKind, private tier: { particles: number; cap: number }, seed = 7) {
    this.rand = rng(seed);
  }

  setParams(p: PreviewKind, tier: { particles: number; cap: number }): void {
    this.p = p;
    this.tier = tier;
  }

  /** Advance by `dt` seconds. */
  step(dt: number): void {
    const p = this.p;
    const rate = emissionRate(previewRate(p), previewLife(p), this.tier);
    this.carry += rate * dt;
    for (; this.carry >= 1; this.carry -= 1) this.dots.push(this.spawn());
    for (const d of this.dots) {
      d.age += dt;
      if (p.kind === "effect") {
        d.vy += p.effect.lift * dt;
        d.vx += (this.rand() - 0.5) * p.effect.wander * 4 * dt;
      } else if (p.kind === "splash") d.vy -= p.splash.gravity * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
    }
    this.dots = this.dots.filter((d) => d.age < d.life);
  }

  private spawn(): Dot {
    const r = this.rand;
    const p = this.p;
    if (p.kind === "effect") {
      const e = p.effect;
      const a = r() * Math.PI * 2;
      const speed = e.speed[0] + r() * (e.speed[1] - e.speed[0]);
      const spread = e.shape === "cone" ? 0.4 : 1;
      return {
        x: Math.cos(a) * e.radius * r(), y: e.shape === "ring" ? 0 : Math.abs(Math.sin(a)) * e.radius * 0.3,
        vx: Math.cos(a) * speed * spread, vy: Math.abs(Math.sin(a)) * speed * (e.shape === "cone" ? 1 : 0.5),
        age: 0, life: e.life[0] + r() * (e.life[1] - e.life[0]), size: e.size[0] + r() * (e.size[1] - e.size[0]),
      };
    }
    if (p.kind === "weather") {
      const w = p.weather;
      return { x: (r() - 0.5) * w.area[0] * 0.2, y: 6, vx: (r() - 0.5) * w.drift, vy: -w.fall, age: 0, life: Math.min(w.life, 6 / Math.max(0.1, Math.abs(w.fall))), size: w.size };
    }
    const s = p.splash;
    const a = ((r() - 0.5) * 2 * s.spreadDeg * Math.PI) / 180;
    return { x: 0, y: 0, vx: Math.sin(a) * s.speed, vy: Math.cos(a) * s.speed, age: 0, life: s.life, size: s.size };
  }
}

// ---------------------------------------------------------------- colour

const toSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);

/** A linear RGB colour (0..1 each) as the #rrggbb the screen shows. */
export function linearToHex(c: readonly [number, number, number]): string {
  return `#${c.map((v) => byte(toSrgb(Math.min(1, Math.max(0, v)))).toString(16).padStart(2, "0")).join("")}`;
}

export function hexToLinear(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)].map((v) => Math.round(v * 1000) / 1000) as Rgb;
}

// ---------------------------------------------------------------- toon preview

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / Math.max(1e-6, e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * The toon colour at a surface point lit with `nDotL` (-1..1): the
 * half-Lambert term cut into shadow and lit by the band edges, the shadow
 * taken from the ramp (darkest at the far side, its edge near the band),
 * a rim on grazing angles. A preview of the shader's look, not a copy.
 */
export function toonColour(
  nDotL: number,
  nDotV: number,
  base: Rgb,
  ramp: [Rgb, Rgb],
  toon: { band: [number, number]; rim: number; rimPower: number },
): Rgb {
  const half = nDotL * 0.5 + 0.5;
  const lit = smooth(toon.band[0], toon.band[1], half);
  const depth = smooth(0, toon.band[0], half);
  const out = [0, 1, 2].map((c) => {
    const shadow = (ramp[0][c] + (ramp[1][c] - ramp[0][c]) * depth) * base[c];
    return shadow + (base[c] - shadow) * lit;
  });
  const rim = toon.rim * (1 - Math.max(0, nDotV)) ** toon.rimPower * lit;
  return out.map((v) => Math.min(1, v + rim)) as Rgb;
}
