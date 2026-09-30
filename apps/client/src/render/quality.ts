/**
 * Quality presets: how much the client draws, chosen for the player's GPU.
 *
 * At start the GPU is classified with @pmndrs/detect-gpu (benchmark
 * scores by renderer; the benchmark data is served by this app, see
 * vite-gpu-benchmarks.ts, never fetched from a CDN) into a tier, and the
 * tier picks a preset:
 *
 * - low: no screen effects, native resolution capped at 1, fewer particles
 * - medium: bloom and tone mapping, half-resolution ambient occlusion
 * - high: full ambient occlusion, the physical sky
 * - ultra: full-resolution ambient occlusion, more particles
 *
 * While playing, a frame-rate governor (drei's PerformanceMonitor in
 * WorldCanvas) lowers the resolution first, then the preset, when frames
 * drop, and raises them back (never above what the player chose) when
 * there's headroom. The player can pin a preset from the HUD.
 */

import type * as THREE from "three";

export const QUALITY_TIERS = ["low", "medium", "high", "ultra"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

export interface QualitySettings {
  tier: QualityTier;
  /** Device-pixel-ratio range: the governor moves within it. */
  dpr: [number, number];
  /** The composer at all (bloom, tone mapping, underwater, AO); off draws the scene straight to the screen. */
  effects: boolean;
  /** Composer MSAA samples. */
  msaa: number;
  bloom: boolean;
  /** Ambient occlusion (n8ao): off, or its quality and resolution. */
  ao: false | { quality: "performance" | "low" | "medium" | "high" | "ultra"; halfRes: boolean };
  /** Particle budget multiplier (weather, effects, auras). */
  particles: number;
  /** Toon outlines on characters. */
  outlines: boolean;
  /** "physical": the takram precomputed-scattering sky and aerial perspective; "classic": DaySky's keyframed sky. */
  sky: "classic" | "physical";
}

export const QUALITY_PRESETS: Record<QualityTier, QualitySettings> = {
  low: { tier: "low", dpr: [0.75, 1], effects: false, msaa: 0, bloom: false, ao: false, particles: 0.4, outlines: false, sky: "classic" },
  medium: { tier: "medium", dpr: [1, 1.5], effects: true, msaa: 2, bloom: true, ao: { quality: "performance", halfRes: true }, particles: 0.7, outlines: true, sky: "classic" },
  high: { tier: "high", dpr: [1, 2], effects: true, msaa: 4, bloom: true, ao: { quality: "medium", halfRes: true }, particles: 1, outlines: true, sky: "physical" },
  ultra: { tier: "ultra", dpr: [1, 2], effects: true, msaa: 4, bloom: true, ao: { quality: "high", halfRes: false }, particles: 1.5, outlines: true, sky: "physical" },
};

/** What detect-gpu said (the fields we use). */
export interface GpuTierResult {
  tier: number;
  isMobile?: boolean;
  type: string;
  fps?: number;
  gpu?: string;
}

/**
 * The preset for a GPU: software rendering and tiers 0–1 get low; tier 2
 * medium (low on mobile); tier 3 high, ultra on a desktop GPU benchmarked
 * well above 60 fps. A GPU the benchmarks don't know (or a failed fetch)
 * gets medium: safe, and the governor raises it if there's headroom.
 */
export function tierForGpu(r: GpuTierResult, software = false): QualityTier {
  if (software || r.type === "WEBGL_UNSUPPORTED" || r.type === "BLOCKLISTED") return "low";
  if (r.type === "FALLBACK" || r.type === "BENCHMARK_FETCH_FAILED") return "medium";
  if (r.tier <= 1) return "low";
  if (r.tier === 2) return r.isMobile ? "low" : "medium";
  return !r.isMobile && (r.fps ?? 0) >= 120 ? "ultra" : "high";
}

/** One step down (null at the bottom) or up (null at `cap`). */
export function stepTier(tier: QualityTier, dir: -1 | 1, cap: QualityTier = "ultra"): QualityTier | null {
  const i = QUALITY_TIERS.indexOf(tier) + dir;
  if (i < 0 || i > QUALITY_TIERS.indexOf(cap)) return null;
  return QUALITY_TIERS[i];
}

/** Where the app serves detect-gpu's benchmark data. */
export const GPU_BENCHMARKS_URL = "/gpu-benchmarks";

/** Classify the GPU behind a renderer (never throws: a failure gives medium). */
export async function detectQuality(renderer: THREE.WebGLRenderer, software: boolean): Promise<{ tier: QualityTier; gpu: GpuTierResult | null }> {
  try {
    const { getGPUTier } = await import("@pmndrs/detect-gpu");
    const gl = renderer.getContext();
    const r = await getGPUTier({ glContext: gl, benchmarksURL: GPU_BENCHMARKS_URL });
    return { tier: tierForGpu(r, software), gpu: r };
  } catch (e) {
    console.info(`[quality] GPU detection failed, using medium: ${e instanceof Error ? e.message : String(e)}`);
    return { tier: software ? "low" : "medium", gpu: null };
  }
}
