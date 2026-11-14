/**
 * Building weathering & personality mask evaluator.
 *
 * Computes deterministic, zero-runtime-overhead weathering channels across
 * structure surfaces:
 *   - Moisture & aspect-driven: `moss`, `lichen`, `sunDried`
 *   - Settlement-age-driven:    `cracking`, `dirt`, `soot`, `wornThresholds`
 *
 * Building age comes from settlement world state rather than random noise so
 * newly founded settlements read noticeably fresher than ancient ruins.
 */

import { z } from "zod";
import { valueNoise } from "@mmo-engine/placement";
import { placementBox } from "./structure-checks.js";
import type { SynthesizedPlacement, Vec3Tuple } from "./types.js";

export const WEATHERING_CHANNELS = [
  "moss",
  "lichen",
  "sunDried",
  "cracking",
  "dirt",
  "soot",
  "wornThresholds",
] as const;

export type WeatheringChannel = (typeof WEATHERING_CHANNELS)[number];

export type WeatheringChannels = Record<WeatheringChannel, number>;

export const Vec3Schema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);

export const BuildingWeatheringInputsSchema = z
  .object({
    moisture: z.number().min(0).max(1),
    /** Dominant facade / lot aspect azimuth in degrees (0 = +Z, 90 = +X, 180 = -Z, 270 = -X). */
    aspectDeg: z.number().finite(),
    /** Settlement-authored building age in years (0 = brand new construction). */
    buildingAgeYears: z.number().min(0).finite(),
    /** World sun azimuth in degrees (default 180 = sun shining from -Z onto -Z faces). */
    sunAzimuthDeg: z.number().finite().default(180),
    /** Optional global exposure factor [0, 1] for canyon/canopy overcast shading. */
    ambientSunExposure: z.number().min(0).max(1).optional(),
    groundY: z.number().finite().default(0),
    chimneyPositions: z.array(Vec3Schema).default([]),
    thresholdPositions: z.array(Vec3Schema).default([]),
    footTraffic: z.number().min(0).max(2).default(1),
    hearthActivity: z.number().min(0).max(2).default(1),
    seed: z.number().int().default(0),
  })
  .strict();

export type BuildingWeatheringInputs = z.infer<typeof BuildingWeatheringInputsSchema>;
export type BuildingWeatheringInputParams = z.input<typeof BuildingWeatheringInputsSchema>;

export interface WeatheringSamplePoint {
  position: Vec3Tuple;
  normal?: Vec3Tuple;
  surfaceTag?: "wall" | "roof" | "trim" | "threshold" | "chimney" | "ground";
}

export interface EvaluatedWeatheringSample {
  position: Vec3Tuple;
  normal: Vec3Tuple;
  surfaceTag: "wall" | "roof" | "trim" | "threshold" | "chimney" | "ground";
  sunExposure: number;
  heightAboveGroundM: number;
  channels: WeatheringChannels;
}

export interface BuildingWeatheringMask {
  inputs: BuildingWeatheringInputs;
  ageFactorStructural: number;
  ageFactorSurface: number;
  meanChannels: WeatheringChannels;
  maxChannels: WeatheringChannels;
  dominantTraits: WeatheringChannel[];
  samples: EvaluatedWeatheringSample[];
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function dist3(a: Vec3Tuple, b: Vec3Tuple): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function minDistanceTo(pos: Vec3Tuple, targets: readonly Vec3Tuple[]): number {
  if (targets.length === 0) return Infinity;
  let best = Infinity;
  for (const t of targets) {
    const d = dist3(pos, t);
    if (d < best) best = d;
  }
  return best;
}

function azimuthToXZ(deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [Math.sin(rad), Math.cos(rad)];
}

/**
 * Compute normalized [0, 1] sun exposure for a surface point given either its
 * explicit outward normal or the building aspect azimuth, relative to sunAzimuthDeg.
 */
export function computeSunExposure(
  normal: Vec3Tuple | undefined,
  aspectDeg: number,
  sunAzimuthDeg: number,
  ambientOverride?: number,
): number {
  const [sx, sz] = azimuthToXZ(sunAzimuthDeg);
  let nx: number;
  let ny: number;
  let nz: number;

  if (normal) {
    const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    nx = normal[0] / len;
    ny = normal[1] / len;
    nz = normal[2] / len;
  } else {
    const [ax, az] = azimuthToXZ(aspectDeg);
    nx = ax;
    ny = 0;
    nz = az;
  }

  const horizLen = Math.hypot(nx, nz);
  const horizDot = horizLen > 1e-4 ? (nx * sx + nz * sz) / horizLen : 0;
  // Map cosine alignment [-1, 1] -> [0.08, 0.96] for vertical walls, plus sky boost for roofs.
  const wallExposure = 0.08 + ((horizDot + 1) * 0.5) * 0.88;
  const upwardMix = clamp01(Math.max(0, ny));
  const rawExposure = wallExposure * (1 - upwardMix * 0.55) + 0.92 * (upwardMix * 0.55);
  const effective =
    ambientOverride !== undefined
      ? rawExposure * (0.35 + 0.65 * clamp01(ambientOverride))
      : rawExposure;
  return round4(clamp01(effective));
}

function saturateAge(ageYears: number, halfLifeYears: number): number {
  if (ageYears <= 0) return 0;
  return 1 - Math.exp(-ageYears / halfLifeYears);
}

function evaluateWeatheringAtPointParsed(
  inputs: BuildingWeatheringInputs,
  point: WeatheringSamplePoint,
): EvaluatedWeatheringSample {
  const heightAboveGroundM = Math.max(0, point.position[1] - inputs.groundY);
  const sunExposure = computeSunExposure(
    point.normal,
    inputs.aspectDeg,
    inputs.sunAzimuthDeg,
    inputs.ambientSunExposure,
  );
  const shade = clamp01(1 - sunExposure);
  const moisture = clamp01(inputs.moisture);

  const ageStructural = saturateAge(inputs.buildingAgeYears, 60);
  const ageSurface = saturateAge(inputs.buildingAgeYears, 24);
  const tag = point.surfaceTag ?? "wall";

  // Deterministic micro-variation in [0.85, 1.15] so adjacent stones vary organically
  // without breaking zero-age / zero-moisture invariants.
  const microA = 0.85 + valueNoise(inputs.seed ^ 0x1357, point.position[0], point.position[2] + heightAboveGroundM * 0.7, 0.45) * 0.3;
  const microB = 0.85 + valueNoise(inputs.seed ^ 0x2468, point.position[0] + 17.3, point.position[2], 0.32) * 0.3;

  // Ground splash & damp wick falloff on vertical walls.
  const dampGroundBand = Math.exp(-heightAboveGroundM / 2.2);
  const splashBand = Math.exp(-heightAboveGroundM / 1.35);

  // Moss thrives on damp, shaded lower walls (0 when completely dry).
  const mossBase =
    moisture *
    (0.32 + 0.68 * shade) *
    (0.45 + 0.55 * dampGroundBand) *
    (0.75 + 0.25 * ageSurface);
  const moss = round4(clamp01(mossBase * microA));

  // Lichen handles higher/more exposed stone and slightly moderate moisture.
  const heightLichenFactor = 0.45 + 0.55 * clamp01(heightAboveGroundM / 3.0);
  const lichenMoisture = Math.pow(moisture, 0.75) * (0.55 + 0.45 * shade);
  const lichen = round4(
    clamp01(lichenMoisture * heightLichenFactor * (0.65 + 0.35 * ageStructural) * microB),
  );

  // Sun-dried wear increases with high sun exposure and dry climate.
  const dryness = clamp01(1 - moisture * 0.85);
  const sunDried = round4(
    clamp01(sunExposure * dryness * (0.7 + 0.3 * ageStructural) * microA),
  );

  // Structural & use-wear channels stay strictly 0 at buildingAgeYears === 0.
  const freezeOrDryStress = 0.55 + 0.45 * Math.max(moisture, sunExposure);
  const cracking =
    inputs.buildingAgeYears <= 0
      ? 0
      : round4(clamp01(ageStructural * freezeOrDryStress * microB));

  const dirt =
    inputs.buildingAgeYears <= 0
      ? 0
      : round4(clamp01(ageSurface * splashBand * (0.45 + 0.55 * moisture) * microA));

  // Soot clusters radially around chimneys/hearths or explicit "chimney" surface tags.
  let sootProximity = tag === "chimney" ? 0.95 : 0;
  if (inputs.chimneyPositions.length > 0) {
    const dChimney = minDistanceTo(point.position, inputs.chimneyPositions);
    sootProximity = Math.max(sootProximity, Math.exp(-(dChimney * dChimney) / 6.25));
  }
  const soot =
    inputs.buildingAgeYears <= 0
      ? 0
      : round4(clamp01(ageSurface * inputs.hearthActivity * sootProximity * microB));

  // Threshold wear clusters around doorway threshold positions or explicit threshold tags.
  let thresholdProximity = tag === "threshold" ? 0.95 : 0;
  if (inputs.thresholdPositions.length > 0) {
    const dThresh = minDistanceTo(point.position, inputs.thresholdPositions);
    thresholdProximity = Math.max(thresholdProximity, Math.exp(-(dThresh * dThresh) / 3.24));
  }
  const wornThresholds =
    inputs.buildingAgeYears <= 0
      ? 0
      : round4(clamp01(ageSurface * inputs.footTraffic * thresholdProximity * microA));

  const defaultNormal: Vec3Tuple = (() => {
    if (point.normal) return point.normal;
    const [ax, az] = azimuthToXZ(inputs.aspectDeg);
    return [ax, 0, az];
  })();

  return {
    position: point.position,
    normal: defaultNormal,
    surfaceTag: tag,
    sunExposure,
    heightAboveGroundM: round4(heightAboveGroundM),
    channels: {
      moss,
      lichen,
      sunDried,
      cracking,
      dirt,
      soot,
      wornThresholds,
    },
  };
}

/**
 * Evaluate all 7 weathering channels at a single 3D surface point.
 */
export function evaluateWeatheringAtPoint(
  rawInputs: BuildingWeatheringInputParams,
  point: WeatheringSamplePoint,
): EvaluatedWeatheringSample {
  return evaluateWeatheringAtPointParsed(
    BuildingWeatheringInputsSchema.parse(rawInputs),
    point,
  );
}

function isPlacementItem(
  item: WeatheringSamplePoint | SynthesizedPlacement,
): item is SynthesizedPlacement {
  return "partId" in item && "transform" in item;
}

function deriveSamplesFromPlacements(
  placements: readonly SynthesizedPlacement[],
  groundY: number,
  aspectDeg: number,
): WeatheringSamplePoint[] {
  const samples: WeatheringSamplePoint[] = [];
  for (const p of placements) {
    const box = placementBox(p);
    const cx = (box.min[0] + box.max[0]) * 0.5;
    const cy = (box.min[1] + box.max[1]) * 0.5;
    const cz = (box.min[2] + box.max[2]) * 0.5;
    const tagLower = `${p.partId} ${p.layer}`.toLowerCase();

    if (p.layer === "roof" || tagLower.includes("roof")) {
      samples.push({ position: [cx, box.max[1], cz], normal: [0, 1, 0], surfaceTag: "roof" });
    } else if (tagLower.includes("chimney")) {
      samples.push({ position: [cx, box.max[1], cz], normal: [0, 0.7, 0.7], surfaceTag: "chimney" });
    } else if (tagLower.includes("door") || tagLower.includes("threshold")) {
      const [ax, az] = azimuthToXZ(aspectDeg);
      samples.push({ position: [cx, groundY + 0.1, cz], normal: [ax, 0, az], surfaceTag: "threshold" });
    } else if (
      p.layer === "exterior" ||
      p.layer === "plinth" ||
      tagLower.includes("wall") ||
      tagLower.includes("facade")
    ) {
      const [ax, az] = azimuthToXZ(aspectDeg);
      samples.push({ position: [cx, Math.max(groundY + 0.15, box.min[1] + 0.25), cz], normal: [ax, 0, az], surfaceTag: "wall" });
      samples.push({ position: [cx, cy, cz], normal: [-ax, 0, -az], surfaceTag: "wall" });
    }
  }
  return samples;
}

function defaultCanonicalSamples(inputs: BuildingWeatheringInputs): WeatheringSamplePoint[] {
  const gy = inputs.groundY;
  const pts: WeatheringSamplePoint[] = [
    { position: [0, gy + 0.25, 2.5], normal: [0, 0, 1], surfaceTag: "wall" },
    { position: [2.5, gy + 0.25, 0], normal: [1, 0, 0], surfaceTag: "wall" },
    { position: [0, gy + 0.25, -2.5], normal: [0, 0, -1], surfaceTag: "wall" },
    { position: [-2.5, gy + 0.25, 0], normal: [-1, 0, 0], surfaceTag: "wall" },
    { position: [0, gy + 2.8, 2.5], normal: [0, 0, 1], surfaceTag: "wall" },
    { position: [0, gy + 4.8, 0], normal: [0, 1, 0], surfaceTag: "roof" },
  ];
  for (const cp of inputs.chimneyPositions) {
    pts.push({ position: cp, normal: [0, 1, 0], surfaceTag: "chimney" });
  }
  for (const tp of inputs.thresholdPositions) {
    const [ax, az] = azimuthToXZ(inputs.aspectDeg);
    pts.push({ position: tp, normal: [ax, 0, az], surfaceTag: "threshold" });
  }
  return pts;
}

/**
 * Evaluate the full weathering & personality mask across surface sample points
 * or synthesized building placements, aggregating per-channel mean/max scores
 * and dominant visible personality traits.
 */
export function evaluateBuildingWeatheringMask(
  rawInputs: BuildingWeatheringInputParams,
  samplesOrPlacements: readonly (WeatheringSamplePoint | SynthesizedPlacement)[] = [],
): BuildingWeatheringMask {
  const inputs = BuildingWeatheringInputsSchema.parse(rawInputs);

  let points: WeatheringSamplePoint[];
  if (samplesOrPlacements.length === 0) {
    points = defaultCanonicalSamples(inputs);
  } else if (isPlacementItem(samplesOrPlacements[0]!)) {
    const derived = deriveSamplesFromPlacements(
      samplesOrPlacements.filter(isPlacementItem),
      inputs.groundY,
      inputs.aspectDeg,
    );
    points = derived.length > 0 ? derived : defaultCanonicalSamples(inputs);
  } else {
    points = samplesOrPlacements as WeatheringSamplePoint[];
  }

  const evaluated = points.map((pt) => evaluateWeatheringAtPointParsed(inputs, pt));

  const meanChannels: WeatheringChannels = {
    moss: 0,
    lichen: 0,
    sunDried: 0,
    cracking: 0,
    dirt: 0,
    soot: 0,
    wornThresholds: 0,
  };
  const maxChannels: WeatheringChannels = { ...meanChannels };

  for (const sample of evaluated) {
    for (const ch of WEATHERING_CHANNELS) {
      meanChannels[ch] += sample.channels[ch];
      if (sample.channels[ch] > maxChannels[ch]) {
        maxChannels[ch] = sample.channels[ch];
      }
    }
  }
  const denom = Math.max(1, evaluated.length);
  for (const ch of WEATHERING_CHANNELS) {
    meanChannels[ch] = round4(meanChannels[ch] / denom);
    maxChannels[ch] = round4(maxChannels[ch]);
  }

  const dominantTraits = WEATHERING_CHANNELS.filter(
    (ch) => maxChannels[ch] >= 0.3 || meanChannels[ch] >= 0.22,
  ).sort((a, b) => maxChannels[b] - maxChannels[a]);

  return {
    inputs,
    ageFactorStructural: round4(saturateAge(inputs.buildingAgeYears, 60)),
    ageFactorSurface: round4(saturateAge(inputs.buildingAgeYears, 24)),
    meanChannels,
    maxChannels,
    dominantTraits,
    samples: evaluated,
  };
}
