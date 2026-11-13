/**
 * WFC 3D Grid <-> Continuous Model Synthesis Bridge.
 *
 * Provides bidirectional translation between continuous spatial model synthesis
 * and discrete 3D WFC grid module propagation (@mmo-engine/wfc).
 *
 * Implements specifications from MODEL-SYNTHESIS-MAP.md §8 (Hybrid Synthesis Pattern).
 */

import {
  solve,
  type ModuleVariationDef,
  type FaceSockets,
  type ModuleGrid3DResult,
  type WfcCount,
  type WfcEdge,
  type WfcOption,
} from "@mmo-engine/wfc";
import type {
  DecompositionLibrary,
  DecorationGrouping,
  LearnedRuleSet,
  RoomType,
  StructurePrototype,
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

const GROUND_ROOM_TYPES = new Set<RoomType>([
  "taproom", "dining_hall", "living_hall", "kitchen_hearth", "smithy_forge",
  "chapel_nave", "study_library", "workshop", "guard_post", "stable_bay",
  "storage_cellar", "entryway", "corridor", "bedroom", "unknown",
]);

const UPPER_ROOM_TYPES = new Set<RoomType>([
  "bedroom", "study_library", "attic_loft", "war_room", "living_hall",
  "storage_cellar", "dining_hall", "guard_post", "corridor", "unknown",
]);

const PRIMARY_ARCHETYPE_ROOM: Record<string, RoomType> = {
  tavern: "taproom",
  inn: "taproom",
  smithy: "smithy_forge",
  forge: "smithy_forge",
  bakery: "kitchen_hearth",
  chapel: "chapel_nave",
  church: "chapel_nave",
  library: "study_library",
  stables: "stable_bay",
  guardhouse: "guard_post",
  barracks: "guard_post",
};

/**
 * Use @mmo-engine/wfc `solve()` to assign coherent RoomTypes across all rooms of
 * a decomposed StructurePrototype, constrained by storey level, archetype priors,
 * and room-graph adjacency.
 */
export function solveBuildingRoomPlan(
  prototype: StructurePrototype,
  library: DecompositionLibrary,
  archetype: string,
  seed: number,
  pinRooms?: readonly RoomType[],
): RoomType[] {
  const rooms = prototype.rooms;
  if (rooms.length === 0) return [];

  const typeSet = new Set<RoomType>();
  for (const r of rooms) typeSet.add(r.roomType);
  for (const k of Object.keys(library.archetypeRoomPriors[archetype] ?? {})) {
    typeSet.add(k as RoomType);
  }
  if (pinRooms) {
    for (const p of pinRooms) typeSet.add(p);
  }
  const primary = PRIMARY_ARCHETYPE_ROOM[archetype.toLowerCase()];
  if (primary) typeSet.add(primary);
  typeSet.add("living_hall");
  typeSet.add("bedroom");

  const roomTypes = [...typeSet];
  const indexOf = new Map<RoomType, number>(roomTypes.map((rt, i) => [rt, i]));
  const options: WfcOption[] = roomTypes.map((id) => ({ id, weight: 1 }));

  const n = rooms.length;
  const k = options.length;
  const weights = new Float64Array(n * k);
  const domains: number[][] = [];
  const pins = new Map<number, number>();
  const priors = library.archetypeRoomPriors[archetype] ?? {};
  const priorSum = Math.max(1, Object.values(priors).reduce((s, v) => s + v, 0));
  let largestGroundIdx = -1;
  let largestGroundArea = -1;
  rooms.forEach((rm, idx) => {
    if (rm.storey === 0) {
      const area = rm.bounds.size[0] * rm.bounds.size[2];
      if (area > largestGroundArea) {
        largestGroundArea = area;
        largestGroundIdx = idx;
      }
    }
  });

  for (let i = 0; i < n; i++) {
    const rm = rooms[i];
    const allowedSet = rm.storey > 0 ? UPPER_ROOM_TYPES : GROUND_ROOM_TYPES;
    const dom: number[] = [];

    for (let o = 0; o < k; o++) {
      const rt = roomTypes[o];
      const pinnedHere = pinRooms?.[i] === rt;
      if (!allowedSet.has(rt) && !pinnedHere && rm.roomType !== rt) continue;
      dom.push(o);
      let w = 0.15;
      if (rm.roomType === rt) w += 4.5;
      if (priors[rt]) w += 1.5 * (priors[rt] / priorSum);
      if (i === largestGroundIdx && primary === rt) w += 4.0;
      weights[i * k + o] = w;
    }

    if (dom.length === 0) {
      const fallbackIdx = indexOf.get(rm.roomType) ?? 0;
      dom.push(fallbackIdx);
      weights[i * k + fallbackIdx] = 1;
    }
    domains.push(dom);

    if (pinRooms?.[i]) {
      const pid = indexOf.get(pinRooms[i]);
      if (pid !== undefined) pins.set(i, pid);
    }
  }

  const roomIdxById = new Map(rooms.map((r, i) => [r.id, i]));
  const edges: WfcEdge[] = [];
  for (const edge of prototype.roomGraph) {
    const a = roomIdxById.get(edge.fromRoomId);
    const b = roomIdxById.get(edge.toRoomId);
    if (a !== undefined && b !== undefined && a !== b) {
      edges.push({ a, b, rule: "room-adj" });
    }
  }

  try {
    const sol = solve(
      {
        options,
        slots: n,
        domains,
        weights,
        edges,
        pins,
        rules: {
          "room-adj": (x, y) => {
            if ((x.id === "smithy_forge" && y.id === "bedroom") || (x.id === "bedroom" && y.id === "smithy_forge")) {
              return false;
            }
            if ((x.id === "stable_bay" && y.id === "kitchen_hearth") || (x.id === "kitchen_hearth" && y.id === "stable_bay")) {
              return false;
            }
            return true;
          },
        },
      },
      { seed, maxBacktracks: 400, maxRestarts: 2 },
    );
    return sol.ids as RoomType[];
  } catch {
    return rooms.map((r, i) => pinRooms?.[i] ?? r.roomType);
  }
}

const UNIQUE_VIGNETTE_KINDS = new Set([
  "bar_service",
  "hearth_station",
  "forge_station",
  "war_table_cluster",
]);

/**
 * Use @mmo-engine/wfc `solve()` to choose complementary interior DecorationGroupings
 * for a single room without duplicating unique centerpieces like bars or hearths.
 */
export function solveRoomVignetteSlots(
  roomType: RoomType,
  candidates: readonly DecorationGrouping[],
  maxSlots: number,
  seed: number,
): DecorationGrouping[] {
  if (candidates.length === 0 || maxSlots <= 0) return [];

  const options: WfcOption[] = [
    { id: "__empty", weight: 0.04 },
    ...candidates.map((v) => ({
      id: v.id,
      weight: Math.max(0.1, (v.observedCount || 1) * (v.roomTypes.includes(roomType) ? 4.5 : 0.7)),
    })),
  ];

  const uniqueByKind = new Map<string, number[]>();
  candidates.forEach((v, idx) => {
    if (!UNIQUE_VIGNETTE_KINDS.has(v.kind)) return;
    if (!uniqueByKind.has(v.kind)) uniqueByKind.set(v.kind, []);
    uniqueByKind.get(v.kind)!.push(idx + 1);
  });

  const counts: WfcCount[] = [...uniqueByKind.values()].map((opts) => ({
    options: opts,
    max: 1,
  }));

  const slots = Math.min(maxSlots, Math.max(1, candidates.length));
  const edges: WfcEdge[] = [];
  for (let i = 0; i < slots - 1; i++) {
    edges.push({ a: i, b: i + 1, rule: "no-adjacent-dup" });
  }

  try {
    const sol = solve(
      {
        options,
        slots,
        edges,
        counts,
        rules: {
          "no-adjacent-dup": (x, y) => {
            if (x.id === "__empty" || y.id === "__empty") return true;
            return x.id !== y.id || !candidates.some((c) => c.id === x.id && UNIQUE_VIGNETTE_KINDS.has(c.kind));
          },
        },
      },
      { seed, maxBacktracks: 200, maxRestarts: 2 },
    );
    const byId = new Map(candidates.map((c) => [c.id, c]));
    return sol.ids.map((id) => byId.get(id)).filter((v): v is DecorationGrouping => v !== undefined);
  } catch {
    return candidates.slice(0, maxSlots);
  }
}
