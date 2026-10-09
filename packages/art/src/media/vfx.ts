/**
 * Particle effects and quality tiers as data (content/vfx/effects.json and
 * content/vfx/tiers.json). The client builds its three.quarks and nebula
 * emitters from these (apps/client render/vfx, render/fx); the editor's VFX
 * panel edits them and checks every effect against each tier's budget.
 */
import { checker, isObj, type MediaIssue, type Obj } from "./issue.js";

export const QUALITY_TIER_NAMES = ["low", "medium", "high", "ultra"] as const;
export type TierName = (typeof QUALITY_TIER_NAMES)[number];

/** A composer particle effect (three.quarks), by id. */
export interface ParticleEffect {
  /** Start and end colour (#rrggbb). */
  color: [string, string];
  /** Opacity at birth, peak and death. */
  alpha: [number, number, number];
  size: [number, number];
  life: [number, number];
  speed: [number, number];
  /** Particles a second before the tier's multiplier. */
  rate: number;
  shape: "sphere" | "cone" | "ring";
  radius: number;
  /** Upward (+) or downward (-) acceleration, m/s^2. */
  lift: number;
  wander: number;
  orbit?: number;
  blending: "additive" | "normal";
  texture: "soft" | "spark";
}

/** A weather emitter (three-nebula): a box of particles that follows the camera. */
export interface WeatherEffect {
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

export interface SplashEffect {
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

export const WEATHER_KINDS = ["snow", "rain", "ash"] as const;

export interface VfxDoc {
  version: 1;
  effects: Record<string, ParticleEffect>;
  weather: Record<(typeof WEATHER_KINDS)[number], WeatherEffect>;
  splash: SplashEffect;
}

/** One quality tier: what the client draws. Post effects (bloom, AO, MSAA) and the particle budgets live here. */
export interface TierPreset {
  tier: TierName;
  dpr: [number, number];
  effects: boolean;
  msaa: number;
  bloom: boolean;
  ao: false | { quality: "performance" | "low" | "medium" | "high" | "ultra"; halfRes: boolean };
  /** Particle multiplier applied to every emission rate. */
  particles: number;
  outlines: boolean;
  sky: "classic" | "physical";
  /** Most live particles one composer effect may hold at this tier. */
  effectBudget: number;
  /** Most live weather particles at this tier. */
  weatherBudget: number;
}

export interface TiersDoc {
  version: 1;
  tiers: Record<TierName, TierPreset>;
}

const pair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));

export function validateVfx(doc: unknown): MediaIssue[] {
  const c = checker();
  if (!isObj(doc)) return [{ path: "", message: "vfx must be an object" }];
  if (doc.version !== 1) c.add("version", "must be 1");
  if (!isObj(doc.effects) || Object.keys(doc.effects).length === 0) c.add("effects", "must be an object with at least one effect");
  else {
    for (const [id, raw] of Object.entries(doc.effects)) {
      const p = `effects.${id}.`;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) c.add(`effects.${id}`, "id must be lowercase letters, digits and dashes");
      if (!isObj(raw)) {
        c.add(`effects.${id}`, "must be an object");
        continue;
      }
      const e: Obj = raw;
      if (!Array.isArray(e.color) || e.color.length !== 2 || !e.color.every((s) => typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s))) c.add(`${p}color`, "must be two #rrggbb colours");
      if (!Array.isArray(e.alpha) || e.alpha.length !== 3 || !e.alpha.every((n) => typeof n === "number" && n >= 0 && n <= 1)) c.add(`${p}alpha`, "must be three numbers in 0..1");
      for (const k of ["size", "life", "speed"]) {
        const v = e[k];
        if (!pair(v) || v[0] < 0 || v[1] < v[0]) c.add(`${p}${k}`, "must be [min, max] with 0 <= min <= max");
        else if ((k === "life" || k === "size") && v[0] <= 0) c.add(`${p}${k}`, "must be above 0");
      }
      c.num(e, "rate", p, 0, 5000);
      c.num(e, "radius", p, 0, 50);
      c.num(e, "lift", p, -50, 50);
      c.num(e, "wander", p, 0, 20);
      if (e.orbit !== undefined) c.num(e, "orbit", p, -20, 20);
      if (!["sphere", "cone", "ring"].includes(e.shape as string)) c.add(`${p}shape`, "must be sphere, cone or ring");
      if (!["additive", "normal"].includes(e.blending as string)) c.add(`${p}blending`, "must be additive or normal");
      if (!["soft", "spark"].includes(e.texture as string)) c.add(`${p}texture`, "must be soft or spark");
    }
  }
  if (!isObj(doc.weather)) c.add("weather", "must be an object");
  else {
    for (const k of WEATHER_KINDS) {
      const p = `weather.${k}.`;
      const w = doc.weather[k];
      if (!isObj(w)) {
        c.add(`weather.${k}`, "missing");
        continue;
      }
      c.num(w, "rate", p, 0, 5000);
      c.num(w, "life", p, 0.1, 60);
      c.num(w, "fall", p, -50, 50);
      c.num(w, "size", p, 0.01, 5);
      c.hex(w, "color", p);
      c.num(w, "alpha", p, 0, 1);
      c.num(w, "drift", p, 0, 20);
      if (!Array.isArray(w.area) || w.area.length !== 3 || !w.area.every((n) => typeof n === "number" && n > 0)) c.add(`${p}area`, "must be three positive numbers");
      if (!["soft", "streak"].includes(w.texture as string)) c.add(`${p}texture`, "must be soft or streak");
    }
  }
  if (!isObj(doc.splash)) c.add("splash", "must be an object");
  else {
    const s = doc.splash;
    c.num(s, "count", "splash.", 0, 500);
    c.num(s, "life", "splash.", 0.05, 10);
    c.num(s, "speed", "splash.", 0, 50);
    c.num(s, "spreadDeg", "splash.", 0, 180);
    c.num(s, "size", "splash.", 0.01, 5);
    c.hex(s, "color", "splash.");
    c.num(s, "alpha", "splash.", 0, 1);
    c.num(s, "gravity", "splash.", 0, 50);
    c.num(s, "everySeconds", "splash.", 0.05, 60);
  }
  return c.issues;
}

export function validateTiers(doc: unknown): MediaIssue[] {
  const c = checker();
  if (!isObj(doc)) return [{ path: "", message: "tiers must be an object" }];
  if (doc.version !== 1) c.add("version", "must be 1");
  if (!isObj(doc.tiers)) return [...c.issues, { path: "tiers", message: "must be an object" }];
  for (const name of QUALITY_TIER_NAMES) {
    const p = `tiers.${name}.`;
    const t = doc.tiers[name];
    if (!isObj(t)) {
      c.add(`tiers.${name}`, "missing");
      continue;
    }
    if (t.tier !== name) c.add(`${p}tier`, `must be "${name}"`);
    if (!pair(t.dpr) || t.dpr[0] <= 0 || t.dpr[0] > t.dpr[1] || t.dpr[1] > 4) c.add(`${p}dpr`, "must be [min, max] with 0 < min <= max <= 4");
    for (const k of ["effects", "bloom", "outlines"]) if (typeof t[k] !== "boolean") c.add(`${p}${k}`, "must be true or false");
    c.num(t, "msaa", p, 0, 8);
    c.num(t, "particles", p, 0, 4);
    c.num(t, "effectBudget", p, 0, 100000);
    c.num(t, "weatherBudget", p, 0, 100000);
    if (!["classic", "physical"].includes(t.sky as string)) c.add(`${p}sky`, "must be classic or physical");
    const ao = t.ao;
    if (ao !== false && !(isObj(ao) && ["performance", "low", "medium", "high", "ultra"].includes(ao.quality as string) && typeof ao.halfRes === "boolean")) {
      c.add(`${p}ao`, "must be false or { quality, halfRes }");
    }
  }
  return c.issues;
}

/** Mean live particles an effect holds at a tier (rate x multiplier x mean life). */
export function liveParticles(rate: number, life: number | [number, number], multiplier: number): number {
  const mean = Array.isArray(life) ? (life[0] + life[1]) / 2 : life;
  return rate * multiplier * mean;
}

export interface BudgetRow {
  id: string;
  kind: "effect" | "weather";
  live: Record<TierName, number>;
  budget: Record<TierName, number>;
  over: TierName[];
}

/** Every effect and weather kind against each tier's budget. */
export function budgetReport(vfx: VfxDoc, tiers: TiersDoc): BudgetRow[] {
  const row = (id: string, kind: "effect" | "weather", rate: number, life: number | [number, number]): BudgetRow => {
    const live = {} as Record<TierName, number>;
    const budget = {} as Record<TierName, number>;
    const over: TierName[] = [];
    for (const t of QUALITY_TIER_NAMES) {
      const tier = tiers.tiers[t];
      live[t] = liveParticles(rate, life, tier.particles);
      budget[t] = kind === "effect" ? tier.effectBudget : tier.weatherBudget;
      if (live[t] > budget[t]) over.push(t);
    }
    return { id, kind, live, budget, over };
  };
  return [
    ...Object.entries(vfx.effects).map(([id, e]) => row(id, "effect", e.rate, e.life)),
    ...WEATHER_KINDS.map((k) => row(`weather.${k}`, "weather", vfx.weather[k].rate, vfx.weather[k].life)),
  ];
}
