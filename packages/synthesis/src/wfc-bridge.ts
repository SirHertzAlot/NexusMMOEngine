/**
 * WFC 3D Grid <-> Continuous Model Synthesis Bridge.
 *
 * Provides bidirectional translation between continuous spatial model synthesis
 * and discrete 3D WFC grid module propagation (@mmo-engine/wfc).
 *
 * Implements specifications from MODEL-SYNTHESIS-MAP.md §8 (Hybrid Synthesis Pattern).
 */

import type { ModuleVariationDef, FaceSockets, ModuleGrid3DResult } from "@mmo-engine/wfc";
import type {
  LearnedRuleSet,
  SynthesisProblem,
  SynthesisOutput,
  TransformData,
} from "./types.js";
import { synthesizeAssembly } from "./synthesizer.js";

export interface CompileWfcOptions {
  /** Include props and rubble as discrete variations (default false, as props are best synthesized continuously). */
  includeProps?: boolean;
  /** Minimum frequency count to include as a discrete module variation (default 2). */
  minFrequencyCount?: number;
}

/**
 * Compiles a LearnedRuleSet into 3D WFC ModuleVariationDef array.
 *
 * Translates continuous spatial sockets into discrete 6-face sockets
 * (px, nx, py, ny, pz, nz) compatible with @mmo-engine/wfc/modules3d.
 */
export function compileRuleSetToWfcModules(
  ruleSet: LearnedRuleSet,
  opts: CompileWfcOptions = {}
): ModuleVariationDef[] {
  const includeProps = opts.includeProps ?? false;
  const minCount = opts.minFrequencyCount ?? 2;
  const variations: ModuleVariationDef[] = [];

  for (const part of Object.values(ruleSet.parts)) {
    const freq = ruleSet.stats.partFrequencies[part.id] || 0;
    if (freq < minCount) continue;

    if (!includeProps && (part.category === "prop" || part.category === "rubble")) {
      continue;
    }

    const faceSockets: FaceSockets = {};

    for (const s of part.sockets) {
      const [nx, ny, nz] = s.normal;

      // In WFC modules3d: Z is up/down, X and Y are horizontal
      // In Three.js: Y is up/down, X and Z are horizontal
      if (ny > 0.7) {
        faceSockets.pz = `${part.category}_top`;
      } else if (ny < -0.7) {
        faceSockets.nz = `${part.category}_bottom`;
      } else if (nx > 0.7) {
        faceSockets.px = `${part.category}_side`;
      } else if (nx < -0.7) {
        faceSockets.nx = `${part.category}_side`;
      } else if (nz > 0.7) {
        faceSockets.py = `${part.category}_side`;
      } else if (nz < -0.7) {
        faceSockets.ny = `${part.category}_side`;
      }
    }

    // Determine rotation freedom based on category
    let rotations: 1 | 2 | 4 = 1;
    if (part.category === "wall" || part.category === "stairs" || part.category === "door") {
      rotations = 4;
    } else if (part.category === "floor" || part.category === "ceiling") {
      rotations = 2;
    }

    variations.push({
      id: part.id,
      moduleType: part.category,
      sockets: faceSockets,
      weight: Math.max(0.1, freq / (ruleSet.stats.totalPlacements || 1) * 10),
      rotations,
      modelId: part.assetRef,
      tags: [part.category, ruleSet.family],
    });
  }

  return variations;
}

/**
 * Decorates or extends a discrete WFC 3D dungeon grid using continuous model synthesis.
 *
 * Takes placed module instances as foundation pins and grows fine-grained props,
 * rubble, columns, and architectural variations into the empty spaces.
 */
export function decorateWfcDungeonWithSynthesis(
  wfcResult: ModuleGrid3DResult,
  ruleSet: LearnedRuleSet,
  seed = 42,
  detailBudget = 100
): SynthesisOutput {
  const pins: Array<{ partId: string; transform: TransformData }> = [];

  for (const inst of wfcResult.instances) {
    if (ruleSet.parts[inst.baseId]) {
      // Convert WFC yaw rotation to quaternion
      const yawRad = (inst.rot * Math.PI) / 180;
      const qy = Math.sin(yawRad / 2);
      const qw = Math.cos(yawRad / 2);

      pins.push({
        partId: inst.baseId,
        transform: {
          pos: inst.worldPos,
          rot: [0, qy, 0, qw],
          scale: [1, 1, 1],
        },
      });
    }
  }

  const cellSize = wfcResult.cellSize;
  const boundMinX = 0;
  const boundMaxX = wfcResult.width * cellSize;
  const boundMinY = 0;
  const boundMaxY = wfcResult.depth * cellSize; // WFC depth is Y-height
  const boundMinZ = 0;
  const boundMaxZ = wfcResult.height * cellSize;

  const problem: SynthesisProblem = {
    ruleSet,
    seed,
    site: {
      bounds: {
        min: [boundMinX, boundMinY, boundMinZ],
        max: [boundMaxX, boundMaxY, boundMaxZ],
      },
    },
    pins,
    budget: {
      maxParts: pins.length + detailBudget,
    },
  };

  return synthesizeAssembly(problem);
}
