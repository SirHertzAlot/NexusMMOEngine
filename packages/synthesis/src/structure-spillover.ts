/**
 * Structure-surface spillover detail-layer adapter & generator.
 *
 * Extends the shared Phase 3 detail-layer evaluator (`@mmo-engine/placement`) with
 * a `structure-surface` context so organic detail (vines creeping up stone
 * walls, weeds/moss crossing ground seams onto abutting structures) is baked
 * in one continuous pass rather than stopping hard at asset boundaries.
 *
 * Cross-quad geometry (`buildDetailGeometry`) is always produced for runtime.
 * Any experimental gaussian-splat treatment remains strictly metadata behind an
 * R&D gate.
 */

import { z } from "zod";
import {
  buildDetailGeometry,
  placeDetail,
  type DetailLayerSpec,
  type DetailSample,
  type Placement,
} from "@mmo-engine/placement";
import {
  BuildingWeatheringInputsSchema,
  computeSunExposure,
  type BuildingWeatheringInputParams,
} from "./building-weathering.js";
import { placementBox, type Aabb } from "./structure-checks.js";
import type { SynthesizedPlacement, Vec3Tuple } from "./types.js";

export const STRUCTURE_DETAIL_SURFACES = [
  "structure-surface",
  "wall",
  "floor",
  "ceiling",
  "terrain",
] as const;

export const StructureDetailLayerSchema = z
  .object({
    id: z.string().min(1),
    assetSet: z.string().min(1),
    surface: z.enum(STRUCTURE_DETAIL_SURFACES).default("structure-surface"),
    density: z.number().min(0).max(1),
    noise: z
      .object({
        scale: z.number().positive(),
        threshold: z.number().min(0).max(1),
      })
      .strict(),
    band: z
      .object({
        min: z.number().min(0).max(1),
        max: z.number().min(0).max(1),
      })
      .strict()
      .refine((b) => b.min <= b.max, { message: "band.min must be <= band.max" }),
    affinity: z
      .object({
        weight: z.number().min(0).max(1),
        preference: z.number().min(0).max(1),
      })
      .strict(),
    cluster: z
      .object({
        size: z.number().nonnegative(),
        falloff: z.number().nonnegative(),
      })
      .strict(),
    seed: z.number().int(),
    budget: z.number().int().positive(),
    channel: z.enum(["base", "rock", "wet", "path"]).optional(),
    sampleSpacingM: z.number().positive().default(0.55),
    maxClimbHeightM: z.number().positive().default(3.5),
    groundSpillRadiusM: z.number().nonnegative().default(1.6),
    seamReachM: z.number().nonnegative().default(2.2),
    minMoisture: z.number().min(0).max(1).default(0),
    shadeAffinity: z.number().min(0).max(1).default(0.6),
    treatment: z.enum(["cross-quad", "splat-overlay", "hybrid"]).default("cross-quad"),
    splatBudget: z.number().int().nonnegative().optional(),
    quadSizeM: z.number().positive().default(0.45),
  })
  .strict();

export type StructureDetailLayer = z.infer<typeof StructureDetailLayerSchema>;
export type StructureDetailLayerInput = z.input<typeof StructureDetailLayerSchema>;

export type StructureSurfaceRole = "wall-face" | "seam" | "ground" | "adjacent-wall";

export interface AdjacentStructureRef {
  id: string;
  box: Aabb;
  moisture?: number;
}

export interface StructureSurfaceInput {
  buildingId: string;
  buildingBox?: Aabb;
  placements?: readonly SynthesizedPlacement[];
  groundY?: number;
  weatheringInputs: BuildingWeatheringInputParams;
  adjacentStructures?: readonly AdjacentStructureRef[];
}

export interface StructureSurfaceSample extends DetailSample {
  worldPos: Vec3Tuple;
  normal: Vec3Tuple;
  surfaceRole: StructureSurfaceRole;
  targetStructureId: string;
  heightAboveGroundM: number;
  seamDistanceM: number;
  moisture: number;
  sunExposure: number;
}

export interface SpilloverPlacement {
  worldPos: Vec3Tuple;
  normal: Vec3Tuple;
  surfaceRole: StructureSurfaceRole;
  targetStructureId: string;
  variant: number;
  band: number;
  affinity: number;
}

export interface SpilloverGeometryBatch {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  quads: number;
}

export interface SplatRdGateInfo {
  gateStatus: "rd-only";
  requestedTreatment: "cross-quad" | "splat-overlay" | "hybrid";
  activeRuntimeTreatment: "cross-quad";
  maxSplatBudget: number;
  candidateSplatCount: number;
}

export interface SpilloverLayerResult {
  layerId: string;
  surface: string;
  assetSet: string;
  seed: number;
  tierScale: number;
  candidateCount: number;
  placements: SpilloverPlacement[];
  roleCounts: Record<StructureSurfaceRole, number>;
  geometry: SpilloverGeometryBatch;
  splatExperiment?: SplatRdGateInfo;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function resolveBuildingBox(input: StructureSurfaceInput): Aabb {
  if (input.buildingBox) return input.buildingBox;
  if (input.placements && input.placements.length > 0) {
    const min: Vec3Tuple = [Infinity, Infinity, Infinity];
    const max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
    for (const p of input.placements) {
      const b = placementBox(p);
      min[0] = Math.min(min[0], b.min[0]);
      min[1] = Math.min(min[1], b.min[1]);
      min[2] = Math.min(min[2], b.min[2]);
      max[0] = Math.max(max[0], b.max[0]);
      max[1] = Math.max(max[1], b.max[1]);
      max[2] = Math.max(max[2], b.max[2]);
    }
    return { min, max };
  }
  throw new Error(
    `StructureSurfaceInput("${input.buildingId}") requires either buildingBox or non-empty placements`,
  );
}

function boxDistanceXZ(a: Aabb, b: Aabb): number {
  const dx = Math.max(0, a.min[0] - b.max[0], b.min[0] - a.max[0]);
  const dz = Math.max(0, a.min[2] - b.max[2], b.min[2] - a.max[2]);
  return Math.hypot(dx, dz);
}

function pointToBoxDistanceXZ(x: number, z: number, b: Aabb): number {
  const dx = x < b.min[0] ? b.min[0] - x : x > b.max[0] ? x - b.max[0] : 0;
  const dz = z < b.min[2] ? b.min[2] - z : z > b.max[2] ? z - b.max[2] : 0;
  return Math.hypot(dx, dz);
}

/**
 * Unfold 3D wall/ground position into continuous 2D `(u, v)` space across
 * 90-degree wall-to-ground seams so `@mmo-engine/placement`'s `placeDetail`
 * noise and spatial clustering cross seams without discontinuities.
 */
function unfoldSurfaceCoord(
  worldPos: Vec3Tuple,
  normal: Vec3Tuple,
  heightAboveGroundM: number,
  disambigOffset: number,
): [number, number] {
  const horiz = Math.hypot(normal[0], normal[2]);
  if (horiz > 1e-4 && heightAboveGroundM > 0) {
    const nx = normal[0] / horiz;
    const nz = normal[2] / horiz;
    return [
      round4(worldPos[0] - nx * heightAboveGroundM + disambigOffset),
      round4(worldPos[2] - nz * heightAboveGroundM),
    ];
  }
  return [round4(worldPos[0] + disambigOffset), round4(worldPos[2])];
}

function makeSample(
  worldPos: Vec3Tuple,
  normal: Vec3Tuple,
  surfaceRole: StructureSurfaceRole,
  targetStructureId: string,
  heightAboveGroundM: number,
  seamDistanceM: number,
  maxReachM: number,
  moisture: number,
  weathering: ReturnType<typeof BuildingWeatheringInputsSchema.parse>,
  layer: StructureDetailLayer,
  disambigOffset: number,
): StructureSurfaceSample {
  const sunExposure = computeSunExposure(
    normal,
    weathering.aspectDeg,
    weathering.sunAzimuthDeg,
    weathering.ambientSunExposure,
  );
  const effectiveMoisture = clamp01(
    moisture + (surfaceRole === "seam" ? 0.12 : 0),
  );
  const band = clamp01(seamDistanceM / Math.max(0.25, maxReachM));
  const shadeMatch = 1 - Math.abs((1 - sunExposure) - layer.shadeAffinity);
  const reachDecay = 1 - 0.35 * band;
  const seamBoost = surfaceRole === "seam" ? 0.1 : 0;

  let affinity = 0;
  if (effectiveMoisture >= layer.minMoisture) {
    affinity = clamp01(
      (0.5 * effectiveMoisture + 0.35 * shadeMatch + seamBoost) * reachDecay,
    );
  }

  const [u, v] = unfoldSurfaceCoord(worldPos, normal, heightAboveGroundM, disambigOffset);
  return {
    x: u,
    z: v,
    band: round4(band),
    affinity: round4(affinity),
    worldPos,
    normal,
    surfaceRole,
    targetStructureId,
    heightAboveGroundM: round4(heightAboveGroundM),
    seamDistanceM: round4(seamDistanceM),
    moisture: round4(effectiveMoisture),
    sunExposure,
  };
}

function sampleWallFaces(
  box: Aabb,
  structureId: string,
  surfaceRole: "wall-face" | "adjacent-wall",
  spacing: number,
  groundY: number,
  maxClimbHeightM: number,
  baseSeamOffsetM: number,
  reachLimitM: number,
  moisture: number,
  weathering: ReturnType<typeof BuildingWeatheringInputsSchema.parse>,
  layer: StructureDetailLayer,
  primaryBox?: Aabb,
): StructureSurfaceSample[] {
  const out: StructureSurfaceSample[] = [];
  const wallTopY = Math.min(box.max[1], groundY + maxClimbHeightM);
  const stepY = spacing;
  const maxReach = Math.max(maxClimbHeightM, layer.seamReachM, layer.groundSpillRadiusM);

  const faces: Array<{
    axis: "x" | "z";
    fixed: number;
    normal: Vec3Tuple;
    uMin: number;
    uMax: number;
  }> = [
    { axis: "z", fixed: box.max[2], normal: [0, 0, 1], uMin: box.min[0], uMax: box.max[0] },
    { axis: "z", fixed: box.min[2], normal: [0, 0, -1], uMin: box.min[0], uMax: box.max[0] },
    { axis: "x", fixed: box.max[0], normal: [1, 0, 0], uMin: box.min[2], uMax: box.max[2] },
    { axis: "x", fixed: box.min[0], normal: [-1, 0, 0], uMin: box.min[2], uMax: box.max[2] },
  ];

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi]!;
    for (let u = face.uMin + spacing * 0.5; u <= face.uMax - spacing * 0.25; u += spacing) {
      const wx = face.axis === "z" ? u : face.fixed;
      const wz = face.axis === "z" ? face.fixed : u;

      const distFromPrimary = primaryBox
        ? pointToBoxDistanceXZ(wx, wz, primaryBox)
        : 0;
      if (primaryBox && distFromPrimary > reachLimitM) continue;

      const yStart = surfaceRole === "adjacent-wall" ? groundY + 0.05 : groundY + stepY * 0.6;
      for (let y = yStart; y <= wallTopY + 1e-4; y += stepY) {
        const h = Math.max(0, y - groundY);
        const seamDist = baseSeamOffsetM + distFromPrimary + h;
        if (primaryBox && seamDist > reachLimitM + maxClimbHeightM * 0.6) continue;
        out.push(
          makeSample(
            [round4(wx), round4(y), round4(wz)],
            face.normal,
            surfaceRole,
            structureId,
            h,
            seamDist,
            maxReach,
            moisture,
            weathering,
            layer,
            (fi + 1) * 0.00013,
          ),
        );
      }
    }
  }
  return out;
}

/**
 * Generate unified structure-surface samples across a building's wall faces,
 * wall-ground contact seam, surrounding ground apron, and nearby adjacent
 * structure walls within `seamReachM`.
 */
export function buildStructureSurfaceSamples(
  input: StructureSurfaceInput,
  rawLayer: StructureDetailLayerInput,
): StructureSurfaceSample[] {
  const layer = StructureDetailLayerSchema.parse(rawLayer);
  const weathering = BuildingWeatheringInputsSchema.parse(input.weatheringInputs);
  const box = resolveBuildingBox(input);
  const groundY = input.groundY ?? box.min[1];
  const spacing = layer.sampleSpacingM;
  const maxReach = Math.max(layer.maxClimbHeightM, layer.groundSpillRadiusM, layer.seamReachM);
  const samples: StructureSurfaceSample[] = [];

  // 1. Continuous ground-contact seam around the primary building perimeter.
  const perimeterFaces: Array<{
    axis: "x" | "z";
    fixed: number;
    normal: Vec3Tuple;
    uMin: number;
    uMax: number;
  }> = [
    { axis: "z", fixed: box.max[2], normal: [0, 0, 1], uMin: box.min[0], uMax: box.max[0] },
    { axis: "z", fixed: box.min[2], normal: [0, 0, -1], uMin: box.min[0], uMax: box.max[0] },
    { axis: "x", fixed: box.max[0], normal: [1, 0, 0], uMin: box.min[2], uMax: box.max[2] },
    { axis: "x", fixed: box.min[0], normal: [-1, 0, 0], uMin: box.min[2], uMax: box.max[2] },
  ];
  for (let fi = 0; fi < perimeterFaces.length; fi++) {
    const face = perimeterFaces[fi]!;
    for (let u = face.uMin + spacing * 0.25; u <= face.uMax - spacing * 0.25; u += spacing) {
      const wx = face.axis === "z" ? u : face.fixed;
      const wz = face.axis === "z" ? face.fixed : u;
      samples.push(
        makeSample(
          [round4(wx), round4(groundY + 0.04), round4(wz)],
          face.normal,
          "seam",
          input.buildingId,
          0,
          0,
          maxReach,
          weathering.moisture,
          weathering,
          layer,
          (fi + 1) * 0.00007,
        ),
      );
    }
  }

  // 2. Primary building vertical wall faces ascending from the ground seam.
  samples.push(
    ...sampleWallFaces(
      box,
      input.buildingId,
      "wall-face",
      spacing,
      groundY,
      layer.maxClimbHeightM,
      0,
      maxReach,
      weathering.moisture,
      weathering,
      layer,
    ),
  );

  // 3. Ground apron spilling outward from the primary perimeter seam.
  const spillExtent = Math.max(layer.groundSpillRadiusM, layer.seamReachM);
  if (spillExtent > 0) {
    const minX = box.min[0] - spillExtent;
    const maxX = box.max[0] + spillExtent;
    const minZ = box.min[2] - spillExtent;
    const maxZ = box.max[2] + spillExtent;
    for (let x = minX; x <= maxX + 1e-4; x += spacing) {
      for (let z = minZ; z <= maxZ + 1e-4; z += spacing) {
        const dPrimary = pointToBoxDistanceXZ(x, z, box);
        if (dPrimary <= 1e-3 || dPrimary > spillExtent) continue;

        let localMoisture = weathering.moisture;
        let insideNeighbor = false;
        if (input.adjacentStructures) {
          for (const adj of input.adjacentStructures) {
            if (pointToBoxDistanceXZ(x, z, adj.box) <= 1e-3) {
              insideNeighbor = true;
              break;
            }
            if (adj.moisture !== undefined && pointToBoxDistanceXZ(x, z, adj.box) <= layer.seamReachM) {
              localMoisture = Math.max(localMoisture, adj.moisture);
            }
          }
        }
        if (insideNeighbor) continue;

        samples.push(
          makeSample(
            [round4(x), round4(groundY), round4(z)],
            [0, 1, 0],
            "ground",
            input.buildingId,
            0,
            dPrimary,
            Math.max(0.25, spillExtent),
            localMoisture,
            weathering,
            layer,
            0,
          ),
        );
      }
    }
  }

  // 4. Adjacent structure walls within `seamReachM` (vines bridging seams across lots).
  if (input.adjacentStructures && layer.seamReachM > 0) {
    for (let ai = 0; ai < input.adjacentStructures.length; ai++) {
      const adj = input.adjacentStructures[ai]!;
      const gap = boxDistanceXZ(box, adj.box);
      if (gap > layer.seamReachM) continue;
      const adjMoisture = adj.moisture !== undefined
        ? Math.max(weathering.moisture * 0.75, adj.moisture)
        : weathering.moisture;
      samples.push(
        ...sampleWallFaces(
          adj.box,
          adj.id,
          "adjacent-wall",
          spacing,
          groundY,
          Math.max(0.8, layer.maxClimbHeightM * 0.75),
          0,
          layer.seamReachM,
          adjMoisture,
          weathering,
          layer,
          box,
        ),
      );
    }
  }

  return samples;
}

/**
 * Convert a StructureDetailLayer into `@mmo-engine/placement`'s DetailLayerSpec.
 */
export function toDetailLayerSpec(rawLayer: StructureDetailLayerInput): DetailLayerSpec {
  const layer = StructureDetailLayerSchema.parse(rawLayer);
  return {
    id: layer.id,
    assetSet: layer.assetSet,
    surface: layer.surface,
    density: layer.density,
    noise: layer.noise,
    band: layer.band,
    affinity: layer.affinity,
    cluster: layer.cluster,
    seed: layer.seed,
    budget: layer.budget,
  };
}

function matchSample(
  p: Placement,
  byKey: Map<string, StructureSurfaceSample>,
  samples: readonly StructureSurfaceSample[],
): StructureSurfaceSample | undefined {
  const exact = byKey.get(`${round4(p.x)}:${round4(p.z)}`);
  if (exact) return exact;
  let best: StructureSurfaceSample | undefined;
  let bestDist2 = Infinity;
  for (const s of samples) {
    const dx = s.x - p.x;
    const dz = s.z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      best = s;
    }
  }
  return best;
}

/**
 * Run a structure-surface spillover detail pass via `@mmo-engine/placement`'s
 * `placeDetail` and `buildDetailGeometry`. Always emits runtime cross-quad geometry;
 * any requested splat treatment stays strictly metadata behind an R&D gate.
 */
export function generateSpilloverDetailLayer(
  rawLayer: StructureDetailLayerInput,
  input: StructureSurfaceInput,
  tierScale = 1,
): SpilloverLayerResult {
  const layer = StructureDetailLayerSchema.parse(rawLayer);
  const samples = buildStructureSurfaceSamples(input, layer);
  const spec = toDetailLayerSpec(layer);
  const rawPlacements = placeDetail(spec, samples, tierScale);

  const byKey = new Map<string, StructureSurfaceSample>();
  for (const s of samples) {
    const key = `${round4(s.x)}:${round4(s.z)}`;
    if (!byKey.has(key)) byKey.set(key, s);
  }

  const roleCounts: Record<StructureSurfaceRole, number> = {
    "wall-face": 0,
    seam: 0,
    ground: 0,
    "adjacent-wall": 0,
  };

  const spilloverPlacements: SpilloverPlacement[] = [];

  for (const p of rawPlacements) {
    const matched = matchSample(p, byKey, samples);
    if (!matched) continue;
    roleCounts[matched.surfaceRole]++;
    spilloverPlacements.push({
      worldPos: matched.worldPos,
      normal: matched.normal,
      surfaceRole: matched.surfaceRole,
      targetStructureId: matched.targetStructureId,
      variant: p.variant,
      band: matched.band,
      affinity: matched.affinity,
    });
  }

  // Remap matched placements directly to true XZ coordinates and preserve per-placement
  // elevations via per-column FIFO queues so stacked climbing vines retain distinct Y heights.
  const worldPlacements: Placement[] = spilloverPlacements.map((sp) => ({
    x: sp.worldPos[0],
    z: sp.worldPos[2],
    variant: sp.variant,
  }));
  const heightQueues = new Map<string, number[]>();
  const heightCursors = new Map<string, number>();
  for (const sp of spilloverPlacements) {
    const key = `${sp.worldPos[0]}:${sp.worldPos[2]}`;
    const list = heightQueues.get(key);
    if (list) {
      list.push(sp.worldPos[1]);
    } else {
      heightQueues.set(key, [sp.worldPos[1]]);
    }
  }
  const fallbackGroundY = input.groundY ?? 0;
  const geometry = buildDetailGeometry(worldPlacements, {
    size: layer.quadSizeM,
    height: (x, z) => {
      const key = `${x}:${z}`;
      const list = heightQueues.get(key);
      if (!list || list.length === 0) return fallbackGroundY;
      const idx = heightCursors.get(key) ?? 0;
      heightCursors.set(key, idx + 1);
      return list[Math.min(idx, list.length - 1)]!;
    },
  });

  const splatExperiment: SplatRdGateInfo | undefined =
    layer.treatment !== "cross-quad" || layer.splatBudget !== undefined
      ? {
          gateStatus: "rd-only",
          requestedTreatment: layer.treatment,
          activeRuntimeTreatment: "cross-quad",
          maxSplatBudget: layer.splatBudget ?? 0,
          candidateSplatCount: Math.min(
            layer.splatBudget ?? spilloverPlacements.length,
            spilloverPlacements.length,
          ),
        }
      : undefined;

  return {
    layerId: layer.id,
    surface: layer.surface,
    assetSet: layer.assetSet,
    seed: layer.seed,
    tierScale,
    candidateCount: samples.length,
    placements: spilloverPlacements,
    roleCounts,
    geometry,
    splatExperiment,
  };
}
