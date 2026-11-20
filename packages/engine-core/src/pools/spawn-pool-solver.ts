/**
 * Constraint- & Model-Driven Spawn Pool Solver (Track P2).
 *
 * Compiles world bounds, terrain height/water probes, model bounds, spawn-table
 * archetypes (`collision.fit`, breakables, habitats), creature rules + lairs,
 * civic vein templates + anchors, resources, chests, exclusion zones, slope
 * limits, and spatial overlap clearances into an L2-cache-bounded `SpawnPoolSoA`.
 */

import type { CivicRules, CreaturesRules, CreatureRules, GatheringRules } from "@mmo-engine/rules";
import { fnv1a32, type SpawnArchetype, type SpawnTable } from "@mmo-engine/scatter";
import type { ModelBounds } from "../procgen/prop-shape.js";
import {
  computePoolSabLayout,
  DEFAULT_L2_CACHE_BYTES,
  MAX_POOL_CAPACITY,
  PoolSlotFlags,
  RespawnKind,
  SlotState,
  SPAWN_POOL_HEADER_BYTES,
  SpawnPoolSoA,
} from "./spawn-pool-soa.js";

export const MIN_RADIUS_M = 0.05;
export const DEFAULT_FOOTPRINT_RADIUS_M = 0.5;
export const DEFAULT_CLEARANCE_M = 0;
export const AQUATIC_MIN_WATER_DEPTH_M = 0.4;
export const LAND_MAX_WATER_DEPTH_M = 0.1;

const MAX_KEY_BYTES_LEN = 65_535;
const SPATIAL_CELL_M = 8;
const LARGE_OBSTACLE_RADIUS_M = 32;
const DEFAULT_SLOPE_STEP_M = 1;
const DEFAULT_HOUR_MS = 3_600_000;
const UTF8_ENCODER = new TextEncoder();

export interface WorldBounds2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ModelBoundDef {
  radius?: number;
  halfExtents?: readonly [number, number, number];
  size?: readonly [number, number, number];
}

export type ModelBoundsInput =
  | ReadonlyMap<string, ModelBoundDef>
  | Readonly<Record<string, ModelBoundDef>>
  | ModelBounds;

export interface ExclusionZone {
  x: number;
  z: number;
  radiusM: number;
  label?: string;
}

export interface StaticObstacle {
  x: number;
  z: number;
  radiusM: number;
  label?: string;
}

export interface ResourceCandidateInput {
  key: string;
  material: string;
  modelId?: string;
  archetypeId?: string;
  x: number;
  z: number;
  maxStock: number;
  stock?: number;
  regrowHours: number;
  habitat?: "land" | "water";
  fit?: number;
  footprintRadiusM?: number;
  scale?: number;
  persistent?: boolean;
}

export interface ChestCandidateInput {
  key: string;
  modelId?: string;
  archetypeId?: string;
  x: number;
  z: number;
  refillSeconds: number;
  habitat?: "land" | "water";
  fit?: number;
  footprintRadiusM?: number;
  scale?: number;
  persistent?: boolean;
}

export interface BreakableCandidateInput {
  key: string;
  archetypeId?: string;
  modelId?: string;
  x: number;
  z: number;
  respawnSeconds?: number;
  stock?: number;
  maxStock?: number;
  habitat?: "land" | "water";
  fit?: number;
  footprintRadiusM?: number;
  scale?: number;
  persistent?: boolean;
}

export interface CreatureAnchorInput {
  key?: string;
  kind?: string;
  x: number;
  z: number;
  count?: number;
  pack?: readonly [number, number];
  modelId?: string;
  respawnSeconds?: number;
  habitat?: "land" | "water";
  spreadRadiusM?: number;
  fit?: number;
  footprintRadiusM?: number;
}

export type CreatureRuleWithAnchors = Pick<CreatureRules, "respawnSeconds"> &
  Partial<Omit<CreatureRules, "respawnSeconds" | "behavior">> & {
    behavior?: Partial<NonNullable<CreatureRules["behavior"]>>;
    modelId?: string;
    lairs?: readonly CreatureAnchorInput[];
    anchors?: readonly CreatureAnchorInput[];
  };

export interface CompileSpawnPoolInput {
  bounds: WorldBounds2D;
  groundHeightAt: (x: number, z: number) => number;
  waterDepthAt?: (x: number, z: number) => number;
  modelBounds?: ModelBoundsInput;
  spawnTable?: SpawnTable;
  creatures?: Readonly<Record<string, CreatureRuleWithAnchors>>;
  creatureSpawns?: readonly (CreatureAnchorInput & { kind: string })[];
  creatureLairs?: readonly (CreatureAnchorInput & { kind: string })[];
  creatureAnchors?: readonly (CreatureAnchorInput & { kind: string })[];
  creatureModels?: Readonly<Record<string, string>>;
  civicRules?: CivicRules;
  veinModels?: Readonly<Record<string, string>>;
  gatheringRules?: GatheringRules;
  resources?: readonly ResourceCandidateInput[];
  chests?: readonly ChestCandidateInput[];
  breakables?: readonly BreakableCandidateInput[];
  exclusionZones?: readonly ExclusionZone[];
  settlementExclusions?: readonly ExclusionZone[];
  staticObstacles?: readonly StaticObstacle[];
  maxSlopeRad?: number;
  defaultClearanceM?: number;
  defaultRadiusM?: number;
  maxSlots?: number;
  maxMemoryBytes?: number;
}

export interface ConstraintBreakdown {
  outOfBounds: number;
  exclusionZone: number;
  waterHabitat: number;
  slopeTooSteep: number;
  modelOverlap: number;
  capacityCapped: number;
  duplicateKey: number;
}

export interface ConstraintReport {
  totalCandidates: number;
  accepted: number;
  rejected: number;
  breakdown: ConstraintBreakdown;
  sabBytes: number;
  utilizationPct: number;
  modelRadiiResolved: number;
  resolvedModelRadiiById: Record<string, number>;
  byKind: {
    creature: number;
    resourceNode: number;
    civicVein: number;
    chest: number;
    breakableProp: number;
    resident: number;
  };
}

export interface CompileSpawnPoolResult {
  pool: SpawnPoolSoA;
  report: ConstraintReport;
}

interface InternalCandidate {
  key: string;
  kind: RespawnKind;
  archetypeId: string;
  modelId: string;
  x: number;
  z: number;
  habitat: "land" | "water";
  stock: number;
  maxStock: number;
  anchorIndex: number;
  respawnDelayMs: number;
  flags: number;
  footprintRadiusM: number;
  modelResolved: boolean;
  resolvedRadiusKey?: string;
}

interface AcceptedPlacement extends InternalCandidate {
  y: number;
  keyBytesLen: number;
}

interface PlacedItem {
  x: number;
  z: number;
  r: number;
}

class SpatialObstacleIndex {
  private readonly cells = new Map<number, Map<number, number[]>>();
  private readonly items: PlacedItem[] = [];
  private readonly largeIndices: number[] = [];
  private visitStamps = new Uint32Array(256);
  private visitToken = 0;

  insert(x: number, z: number, r: number): void {
    const idx = this.items.length;
    this.items.push({ x, z, r });
    if (idx >= this.visitStamps.length) {
      const next = new Uint32Array(this.visitStamps.length * 2);
      next.set(this.visitStamps);
      this.visitStamps = next;
    }

    if (r > LARGE_OBSTACLE_RADIUS_M) {
      this.largeIndices.push(idx);
      return;
    }

    const cx0 = Math.floor((x - r) / SPATIAL_CELL_M);
    const cx1 = Math.floor((x + r) / SPATIAL_CELL_M);
    const cz0 = Math.floor((z - r) / SPATIAL_CELL_M);
    const cz1 = Math.floor((z + r) / SPATIAL_CELL_M);
    for (let cx = cx0; cx <= cx1; cx++) {
      let col = this.cells.get(cx);
      if (!col) {
        col = new Map<number, number[]>();
        this.cells.set(cx, col);
      }
      for (let cz = cz0; cz <= cz1; cz++) {
        let bucket = col.get(cz);
        if (!bucket) {
          bucket = [];
          col.set(cz, bucket);
        }
        bucket.push(idx);
      }
    }
  }

  overlaps(x: number, z: number, r: number, clearanceM: number): boolean {
    const reach = r + clearanceM;
    for (let i = 0; i < this.largeIndices.length; i++) {
      const item = this.items[this.largeIndices[i]!]!;
      const minDist = reach + item.r;
      const dx = x - item.x;
      const dz = z - item.z;
      if (dx * dx + dz * dz < minDist * minDist) return true;
    }

    // Every item in `cells` (r <= LARGE_OBSTACLE_RADIUS_M) is binned over all cells touching
    // [x - r, x + r] x [z - r, z + r], so scanning [x - reach, x + reach] x [z - reach, z + reach]
    // is guaranteed to hit at least one shared cell for any colliding pair.
    const qx0 = Math.floor((x - reach) / SPATIAL_CELL_M);
    const qx1 = Math.floor((x + reach) / SPATIAL_CELL_M);
    const qz0 = Math.floor((z - reach) / SPATIAL_CELL_M);
    const qz1 = Math.floor((z + reach) / SPATIAL_CELL_M);

    const token = ++this.visitToken;
    for (let cx = qx0; cx <= qx1; cx++) {
      const col = this.cells.get(cx);
      if (!col) continue;
      for (let cz = qz0; cz <= qz1; cz++) {
        const bucket = col.get(cz);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const itemIdx = bucket[k]!;
          if (this.visitStamps[itemIdx] === token) continue;
          this.visitStamps[itemIdx] = token;
          const item = this.items[itemIdx]!;
          const minDist = reach + item.r;
          const dx = x - item.x;
          const dz = z - item.z;
          if (dx * dx + dz * dz < minDist * minDist) return true;
        }
      }
    }
    return false;
  }
}

function utf8ByteLength(str: string): number {
  let ascii = true;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  }
  return ascii ? str.length : UTF8_ENCODER.encode(str).byteLength;
}

function lookupModelBound(
  modelBounds: ModelBoundsInput | undefined,
  ids: readonly (string | undefined)[],
): { key: string; entry: ModelBoundDef | readonly [number, number, number] } | undefined {
  if (!modelBounds) return undefined;
  for (const id of ids) {
    if (!id) continue;
    if (typeof modelBounds === "function") {
      const size = modelBounds(id);
      if (size !== undefined) return { key: id, entry: size };
    } else if (typeof (modelBounds as ReadonlyMap<string, ModelBoundDef>).get === "function") {
      const found = (modelBounds as ReadonlyMap<string, ModelBoundDef>).get(id);
      if (found !== undefined) return { key: id, entry: found };
    } else {
      const rec = modelBounds as Readonly<Record<string, ModelBoundDef>>;
      if (Object.prototype.hasOwnProperty.call(rec, id) && rec[id] !== undefined) {
        return { key: id, entry: rec[id]! };
      }
    }
  }
  return undefined;
}

function findSpawnArchetype(
  spawnTable: SpawnTable | undefined,
  archetypeId?: string,
  modelId?: string,
): SpawnArchetype | undefined {
  if (!spawnTable) return undefined;
  if (archetypeId && spawnTable.archetypes[archetypeId]) {
    return spawnTable.archetypes[archetypeId];
  }
  if (modelId && spawnTable.archetypes[modelId]) {
    return spawnTable.archetypes[modelId];
  }
  if (modelId) {
    for (const arch of Object.values(spawnTable.archetypes)) {
      if (arch.asset === modelId) return arch;
    }
  }
  return undefined;
}

/**
 * Resolve exact horizontal footprint radius in metres from model bounds (`radius`
 * or `max(hx, hz)` or `max(sizeX, sizeZ) / 2`) scaled by `collision.fit` & `scale`,
 * clamping any non-positive defined radius to `MIN_RADIUS_M`.
 */
export function resolveModelFootprintRadius(opts: {
  modelIds: readonly (string | undefined)[];
  modelBounds?: ModelBoundsInput;
  archetype?: SpawnArchetype;
  explicitRadiusM?: number;
  fitOverride?: number;
  scale?: number;
  defaultRadiusM?: number;
}): { radiusM: number; resolved: boolean; resolvedKey?: string } {
  const defaultRadiusM = Math.max(MIN_RADIUS_M, opts.defaultRadiusM ?? DEFAULT_FOOTPRINT_RADIUS_M);
  const scale = opts.scale !== undefined && Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : 1;
  const rawFit = opts.fitOverride ?? opts.archetype?.collision?.fit ?? 1;
  const fit = Number.isFinite(rawFit) ? rawFit : 1;

  if (opts.explicitRadiusM !== undefined && Number.isFinite(opts.explicitRadiusM)) {
    const scaled = opts.explicitRadiusM <= 0 ? MIN_RADIUS_M : opts.explicitRadiusM * Math.max(0, fit) * scale;
    return {
      radiusM: Math.max(MIN_RADIUS_M, scaled),
      resolved: true,
      resolvedKey: opts.modelIds.find(Boolean),
    };
  }

  const found = lookupModelBound(opts.modelBounds, opts.modelIds);
  if (found) {
    const { key, entry } = found;
    let baseRadius: number | undefined;
    if (Array.isArray(entry)) {
      if (entry.length >= 3 && Number.isFinite(entry[0]) && Number.isFinite(entry[2])) {
        baseRadius = Math.max(Math.abs(entry[0]!), Math.abs(entry[2]!)) * 0.5;
      }
    } else {
      const def = entry as ModelBoundDef;
      if (def.radius !== undefined) {
        if (Number.isFinite(def.radius)) {
          baseRadius = def.radius;
        }
      } else if (def.halfExtents !== undefined && def.halfExtents.length >= 3) {
        if (Number.isFinite(def.halfExtents[0]) && Number.isFinite(def.halfExtents[2])) {
          baseRadius = Math.max(Math.abs(def.halfExtents[0]!), Math.abs(def.halfExtents[2]!));
        }
      } else if (def.size !== undefined && def.size.length >= 3) {
        if (Number.isFinite(def.size[0]) && Number.isFinite(def.size[2])) {
          baseRadius = Math.max(Math.abs(def.size[0]!), Math.abs(def.size[2]!)) * 0.5;
        }
      }
    }

    if (baseRadius !== undefined) {
      const scaled = baseRadius <= 0 || fit <= 0 ? MIN_RADIUS_M : baseRadius * fit * scale;
      return {
        radiusM: Math.max(MIN_RADIUS_M, scaled),
        resolved: true,
        resolvedKey: key,
      };
    }
  }

  const col = opts.archetype?.collision;
  if (col) {
    if (col.radius !== undefined && Number.isFinite(col.radius)) {
      const scaled = col.radius <= 0 ? MIN_RADIUS_M : col.radius * scale;
      return {
        radiusM: Math.max(MIN_RADIUS_M, scaled),
        resolved: true,
        resolvedKey: opts.archetype?.asset,
      };
    }
    if (col.halfExtents !== undefined) {
      const m = Math.max(Math.abs(col.halfExtents[0]), Math.abs(col.halfExtents[2]));
      const scaled = m <= 0 || fit <= 0 ? MIN_RADIUS_M : m * (opts.fitOverride ?? 1) * scale;
      return {
        radiusM: Math.max(MIN_RADIUS_M, scaled),
        resolved: true,
        resolvedKey: opts.archetype?.asset,
      };
    }
  }

  return {
    radiusM: Math.max(MIN_RADIUS_M, defaultRadiusM * scale),
    resolved: false,
  };
}

/**
 * Estimate terrain slope (radians) via central finite difference over a `1 m` step.
 */
export function estimateSlopeRad(
  groundHeightAt: (x: number, z: number) => number,
  x: number,
  z: number,
  stepM = DEFAULT_SLOPE_STEP_M,
): number {
  const hxp = groundHeightAt(x + stepM, z);
  const hxm = groundHeightAt(x - stepM, z);
  const hzp = groundHeightAt(x, z + stepM);
  const hzm = groundHeightAt(x, z - stepM);
  if (
    !Number.isFinite(hxp) ||
    !Number.isFinite(hxm) ||
    !Number.isFinite(hzp) ||
    !Number.isFinite(hzm)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const dhdx = (hxp - hxm) / (2 * stepM);
  const dhdz = (hzp - hzm) / (2 * stepM);
  return Math.atan(Math.hypot(dhdx, dhdz));
}

function deterministicPackCount(
  kind: string,
  x: number,
  z: number,
  pack: readonly [number, number],
): number {
  const min = Math.max(1, Math.round(pack[0]));
  const max = Math.max(min, Math.round(pack[1]));
  if (min === max) return min;
  const h = fnv1a32(`${kind}:${Math.round(x * 100)}:${Math.round(z * 100)}`);
  return min + (h % (max - min + 1));
}

function collectCandidates(input: CompileSpawnPoolInput, clearanceM: number): InternalCandidate[] {
  const candidates: InternalCandidate[] = [];
  const hourMs = (input.gatheringRules?.regrowHourSeconds ?? 3600) * 1000 || DEFAULT_HOUR_MS;

  // 1. Civic veins & anchors
  if (input.civicRules) {
    for (const vein of input.civicRules.veins) {
      const explicitModel = input.veinModels?.[vein.id] ?? input.veinModels?.[vein.material];
      const modelId = explicitModel ?? vein.id;
      const arch = findSpawnArchetype(input.spawnTable, vein.id, modelId);
      const radiusInfo = resolveModelFootprintRadius({
        modelIds: [explicitModel, vein.id, vein.material, `vein:${vein.material}`, arch?.asset],
        modelBounds: input.modelBounds,
        archetype: arch,
        defaultRadiusM: input.defaultRadiusM,
      });

      for (let i = 0; i < vein.spawnAnchors.length; i++) {
        const anchor = vein.spawnAnchors[i]!;
        candidates.push({
          key: `civic:${vein.id}:${i}`,
          kind: RespawnKind.CivicVein,
          archetypeId: vein.id,
          modelId,
          x: anchor.x,
          z: anchor.z,
          habitat: "land",
          stock: Math.max(0, Math.round(vein.stock)),
          maxStock: Math.max(0, Math.round(vein.stock)),
          anchorIndex: i & 0xffff,
          respawnDelayMs: Number.isFinite(vein.respawnDelayMs) && vein.respawnDelayMs > 0 ? vein.respawnDelayMs : 0,
          flags: (vein.isBaseline ? PoolSlotFlags.Baseline : 0) | PoolSlotFlags.Persistent,
          footprintRadiusM: radiusInfo.radiusM,
          modelResolved: radiusInfo.resolved,
          resolvedRadiusKey: radiusInfo.resolvedKey,
        });
      }
    }
  }

  // 2. Resource nodes
  if (input.resources) {
    for (const res of input.resources) {
      const arch = findSpawnArchetype(input.spawnTable, res.archetypeId, res.modelId ?? res.material);
      const modelId = res.modelId ?? arch?.asset ?? res.material;
      const habitat: "land" | "water" = res.habitat ?? arch?.habitat ?? "land";
      const radiusInfo = resolveModelFootprintRadius({
        modelIds: [res.modelId, arch?.asset, res.archetypeId, res.material],
        modelBounds: input.modelBounds,
        archetype: arch,
        explicitRadiusM: res.footprintRadiusM,
        fitOverride: res.fit,
        scale: res.scale,
        defaultRadiusM: input.defaultRadiusM,
      });
      const maxStock = Number.isFinite(res.maxStock) ? Math.max(0, Math.round(res.maxStock)) : 1;
      const stock = res.stock !== undefined && Number.isFinite(res.stock)
        ? Math.max(0, Math.min(maxStock, Math.round(res.stock)))
        : maxStock;
      const respawnDelayMs = Number.isFinite(res.regrowHours) && res.regrowHours > 0
        ? res.regrowHours * hourMs
        : 0;

      candidates.push({
        key: res.key,
        kind: RespawnKind.ResourceNode,
        archetypeId: res.archetypeId ?? res.material,
        modelId,
        x: res.x,
        z: res.z,
        habitat,
        stock,
        maxStock,
        anchorIndex: 0,
        respawnDelayMs,
        flags: (habitat === "water" ? PoolSlotFlags.Aquatic : 0) | (res.persistent !== false ? PoolSlotFlags.Persistent : 0),
        footprintRadiusM: radiusInfo.radiusM,
        modelResolved: radiusInfo.resolved,
        resolvedRadiusKey: radiusInfo.resolvedKey,
      });
    }
  }

  // 3. Chests
  if (input.chests) {
    for (const chest of input.chests) {
      const arch = findSpawnArchetype(input.spawnTable, chest.archetypeId, chest.modelId);
      const modelId = chest.modelId ?? arch?.asset ?? "chest";
      const habitat: "land" | "water" = chest.habitat ?? arch?.habitat ?? "land";
      const radiusInfo = resolveModelFootprintRadius({
        modelIds: [chest.modelId, arch?.asset, chest.archetypeId, "chest"],
        modelBounds: input.modelBounds,
        archetype: arch,
        explicitRadiusM: chest.footprintRadiusM,
        fitOverride: chest.fit,
        scale: chest.scale,
        defaultRadiusM: input.defaultRadiusM,
      });
      const respawnDelayMs = Number.isFinite(chest.refillSeconds) && chest.refillSeconds > 0
        ? chest.refillSeconds * 1000
        : 0;

      candidates.push({
        key: chest.key,
        kind: RespawnKind.Chest,
        archetypeId: chest.archetypeId ?? modelId,
        modelId,
        x: chest.x,
        z: chest.z,
        habitat,
        stock: 1,
        maxStock: 1,
        anchorIndex: 0,
        respawnDelayMs,
        flags: (habitat === "water" ? PoolSlotFlags.Aquatic : 0) | (chest.persistent !== false ? PoolSlotFlags.Persistent : 0),
        footprintRadiusM: radiusInfo.radiusM,
        modelResolved: radiusInfo.resolved,
        resolvedRadiusKey: radiusInfo.resolvedKey,
      });
    }
  }

  // 4. Breakable props (driven by spawnTable & explicit placements)
  if (input.breakables) {
    for (const brk of input.breakables) {
      const arch = findSpawnArchetype(input.spawnTable, brk.archetypeId, brk.modelId);
      const modelId = brk.modelId ?? arch?.asset ?? brk.archetypeId ?? brk.key;
      const habitat: "land" | "water" = brk.habitat ?? arch?.habitat ?? "land";
      const radiusInfo = resolveModelFootprintRadius({
        modelIds: [brk.modelId, arch?.asset, brk.archetypeId],
        modelBounds: input.modelBounds,
        archetype: arch,
        explicitRadiusM: brk.footprintRadiusM,
        fitOverride: brk.fit,
        scale: brk.scale,
        defaultRadiusM: input.defaultRadiusM,
      });
      const rawRespawnS = brk.respawnSeconds ?? arch?.breakable?.respawnS ?? 0;
      const respawnDelayMs = rawRespawnS !== null && Number.isFinite(rawRespawnS) && rawRespawnS > 0
        ? rawRespawnS * 1000
        : 0;
      const maxStock = brk.maxStock !== undefined && Number.isFinite(brk.maxStock) ? Math.max(0, Math.round(brk.maxStock)) : 1;
      const stock = brk.stock !== undefined && Number.isFinite(brk.stock)
        ? Math.max(0, Math.min(maxStock, Math.round(brk.stock)))
        : maxStock;

      candidates.push({
        key: brk.key,
        kind: RespawnKind.BreakableProp,
        archetypeId: brk.archetypeId ?? arch?.asset ?? modelId,
        modelId,
        x: brk.x,
        z: brk.z,
        habitat,
        stock,
        maxStock,
        anchorIndex: 0,
        respawnDelayMs,
        flags: (habitat === "water" ? PoolSlotFlags.Aquatic : 0) | (brk.persistent !== false ? PoolSlotFlags.Persistent : 0),
        footprintRadiusM: radiusInfo.radiusM,
        modelResolved: radiusInfo.resolved,
        resolvedRadiusKey: radiusInfo.resolvedKey,
      });
    }
  }

  // 5. Creatures (inline lairs/anchors on rules + explicit creatureSpawns / creatureLairs / creatureAnchors)
  const creatureSpawns: Array<CreatureAnchorInput & { kind: string }> = [];
  if (input.creatures) {
    for (const [kind, def] of Object.entries(input.creatures)) {
      if (def.lairs) {
        for (const l of def.lairs) creatureSpawns.push({ ...l, kind: l.kind ?? kind });
      }
      if (def.anchors) {
        for (const a of def.anchors) creatureSpawns.push({ ...a, kind: a.kind ?? kind });
      }
    }
  }
  if (input.creatureSpawns) creatureSpawns.push(...input.creatureSpawns);
  if (input.creatureLairs) creatureSpawns.push(...input.creatureLairs);
  if (input.creatureAnchors) creatureSpawns.push(...input.creatureAnchors);

  for (let lairIdx = 0; lairIdx < creatureSpawns.length; lairIdx++) {
    const sp = creatureSpawns[lairIdx]!;
    const def = input.creatures?.[sp.kind];
    const modelId = sp.modelId ?? def?.modelId ?? input.creatureModels?.[sp.kind] ?? sp.kind;
    const habitat: "land" | "water" = sp.habitat ?? def?.behavior?.habitat ?? "land";
    const scale = def?.behavior?.size ?? 1;
    const arch = findSpawnArchetype(input.spawnTable, sp.kind, modelId);
    const radiusInfo = resolveModelFootprintRadius({
      modelIds: [sp.modelId, def?.modelId, input.creatureModels?.[sp.kind], sp.kind],
      modelBounds: input.modelBounds,
      archetype: arch,
      explicitRadiusM: sp.footprintRadiusM,
      fitOverride: sp.fit,
      scale,
      defaultRadiusM: input.defaultRadiusM,
    });

    const respawnSeconds = sp.respawnSeconds ?? def?.respawnSeconds ?? 60;
    const respawnDelayMs = Number.isFinite(respawnSeconds) && respawnSeconds > 0
      ? respawnSeconds * 1000
      : 0;

    const count = sp.count !== undefined && Number.isFinite(sp.count)
      ? Math.max(1, Math.round(sp.count))
      : Number.isFinite(sp.x) && Number.isFinite(sp.z)
        ? deterministicPackCount(sp.kind, sp.x, sp.z, sp.pack ?? def?.pack ?? [1, 1])
        : 1;

    const ringMinR = count > 1
      ? (2 * radiusInfo.radiusM + clearanceM + 0.1) / (2 * Math.sin(Math.PI / count))
      : 0;
    const ringR = count > 1 ? Math.max(sp.spreadRadiusM ?? 2.0, ringMinR) : 0;

    for (let i = 0; i < count; i++) {
      const px = !Number.isFinite(sp.x) || count === 1
        ? sp.x
        : sp.x + Math.cos((i / count) * Math.PI * 2) * ringR;
      const pz = !Number.isFinite(sp.z) || count === 1
        ? sp.z
        : sp.z + Math.sin((i / count) * Math.PI * 2) * ringR;
      const key = sp.key !== undefined
        ? (count === 1 ? sp.key : `${sp.key}#${i}`)
        : `creature:${sp.kind}:${lairIdx}:${i}`;

      candidates.push({
        key,
        kind: RespawnKind.Creature,
        archetypeId: sp.kind,
        modelId,
        x: px,
        z: pz,
        habitat,
        stock: 1,
        maxStock: 1,
        anchorIndex: i & 0xffff,
        respawnDelayMs,
        flags: (habitat === "water" ? PoolSlotFlags.Aquatic : 0) | PoolSlotFlags.Persistent,
        footprintRadiusM: radiusInfo.radiusM,
        modelResolved: radiusInfo.resolved,
        resolvedRadiusKey: radiusInfo.resolvedKey,
      });
    }
  }

  return candidates;
}

/**
 * Deterministically evaluate world bounds, exclusion zones, habitat depth,
 * terrain slope, model overlap clearance, duplicate keys, and L2 cache budget,
 * producing an aligned `SpawnPoolSoA` and structured `ConstraintReport`.
 */
export function compileSpawnPool(input: CompileSpawnPoolInput): CompileSpawnPoolResult {
  const { bounds, groundHeightAt } = input;
  if (
    !bounds ||
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.minZ) ||
    !Number.isFinite(bounds.maxZ) ||
    bounds.minX > bounds.maxX ||
    bounds.minZ > bounds.maxZ
  ) {
    throw new RangeError("compileSpawnPool: bounds must be finite with minX <= maxX and minZ <= maxZ");
  }

  const maxMemoryBytes = input.maxMemoryBytes ?? DEFAULT_L2_CACHE_BYTES;
  if (!Number.isFinite(maxMemoryBytes) || maxMemoryBytes < SPAWN_POOL_HEADER_BYTES) {
    throw new RangeError(
      `compileSpawnPool: maxMemoryBytes must be finite >= ${SPAWN_POOL_HEADER_BYTES} (got ${maxMemoryBytes})`,
    );
  }

  if (input.maxSlots !== undefined && (!Number.isInteger(input.maxSlots) || input.maxSlots < 0)) {
    throw new RangeError(`compileSpawnPool: maxSlots must be a non-negative integer (got ${input.maxSlots})`);
  }

  const clearanceM = input.defaultClearanceM ?? DEFAULT_CLEARANCE_M;
  if (!Number.isFinite(clearanceM) || clearanceM < 0) {
    throw new RangeError(`compileSpawnPool: defaultClearanceM must be finite >= 0 (got ${clearanceM})`);
  }

  if (input.maxSlopeRad !== undefined && (!Number.isFinite(input.maxSlopeRad) || input.maxSlopeRad < 0)) {
    throw new RangeError(`compileSpawnPool: maxSlopeRad must be finite >= 0 (got ${input.maxSlopeRad})`);
  }

  const effectiveMaxSlots = Math.min(input.maxSlots ?? MAX_POOL_CAPACITY, MAX_POOL_CAPACITY);

  const zones: ExclusionZone[] = [];
  if (input.exclusionZones) {
    for (const z of input.exclusionZones) {
      if (Number.isFinite(z.x) && Number.isFinite(z.z) && Number.isFinite(z.radiusM) && z.radiusM > 0) {
        zones.push(z);
      }
    }
  }
  if (input.settlementExclusions) {
    for (const z of input.settlementExclusions) {
      if (Number.isFinite(z.x) && Number.isFinite(z.z) && Number.isFinite(z.radiusM) && z.radiusM > 0) {
        zones.push(z);
      }
    }
  }

  const grid = new SpatialObstacleIndex();
  if (input.staticObstacles) {
    for (const obs of input.staticObstacles) {
      if (Number.isFinite(obs.x) && Number.isFinite(obs.z) && Number.isFinite(obs.radiusM) && obs.radiusM >= 0) {
        grid.insert(obs.x, obs.z, Math.max(MIN_RADIUS_M, obs.radiusM));
      }
    }
  }

  const candidates = collectCandidates(input, clearanceM);
  const breakdown: ConstraintBreakdown = {
    outOfBounds: 0,
    exclusionZone: 0,
    waterHabitat: 0,
    slopeTooSteep: 0,
    modelOverlap: 0,
    capacityCapped: 0,
    duplicateKey: 0,
  };

  const byKind = {
    creature: 0,
    resourceNode: 0,
    civicVein: 0,
    chest: 0,
    breakableProp: 0,
    resident: 0,
  };

  const resolvedModelRadiiById: Record<string, number> = {};
  let modelRadiiResolved = 0;

  const seenKeys = new Set<string>();
  const accepted: AcceptedPlacement[] = [];
  let totalKeyBytes = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.modelResolved) {
      modelRadiiResolved++;
      const radiusMapKey = c.resolvedRadiusKey ?? c.modelId;
      if (radiusMapKey) resolvedModelRadiiById[radiusMapKey] = c.footprintRadiusM;
    }

    // 1. Coordinate & world-bounds check (before probing ground/water or spatial grid)
    if (
      !Number.isFinite(c.x) ||
      !Number.isFinite(c.z) ||
      c.x < bounds.minX ||
      c.x > bounds.maxX ||
      c.z < bounds.minZ ||
      c.z > bounds.maxZ
    ) {
      breakdown.outOfBounds++;
      continue;
    }

    const y = groundHeightAt(c.x, c.z);
    if (!Number.isFinite(y)) {
      breakdown.outOfBounds++;
      continue;
    }

    // 2. Duplicate/empty key guard
    if (typeof c.key !== "string" || c.key.length === 0 || seenKeys.has(c.key)) {
      breakdown.duplicateKey++;
      continue;
    }
    const keyBytesLen = utf8ByteLength(c.key);
    if (keyBytesLen > MAX_KEY_BYTES_LEN) {
      breakdown.outOfBounds++;
      continue;
    }
    seenKeys.add(c.key);

    // 3. Exclusion & settlement zones
    let inExclusion = false;
    for (let j = 0; j < zones.length; j++) {
      const zone = zones[j]!;
      const dx = c.x - zone.x;
      const dz = c.z - zone.z;
      if (dx * dx + dz * dz < zone.radiusM * zone.radiusM) {
        inExclusion = true;
        break;
      }
    }
    if (inExclusion) {
      breakdown.exclusionZone++;
      continue;
    }

    // 4. Water / land habitat constraint
    const waterDepth = input.waterDepthAt ? input.waterDepthAt(c.x, c.z) : 0;
    if (!Number.isFinite(waterDepth)) {
      breakdown.waterHabitat++;
      continue;
    }
    if (c.habitat === "water") {
      if (waterDepth < AQUATIC_MIN_WATER_DEPTH_M) {
        breakdown.waterHabitat++;
        continue;
      }
    } else if (waterDepth > LAND_MAX_WATER_DEPTH_M) {
      breakdown.waterHabitat++;
      continue;
    }

    // 5. Slope check via 1 m central finite difference
    if (input.maxSlopeRad !== undefined) {
      const slopeRad = estimateSlopeRad(groundHeightAt, c.x, c.z, DEFAULT_SLOPE_STEP_M);
      if (!Number.isFinite(slopeRad) || slopeRad > input.maxSlopeRad) {
        breakdown.slopeTooSteep++;
        continue;
      }
    }

    // 6. Spatial model overlap check (against placed slots + static obstacles)
    if (grid.overlaps(c.x, c.z, c.footprintRadiusM, clearanceM)) {
      breakdown.modelOverlap++;
      continue;
    }

    // 7. Capacity cap & L2 memory budget enforcement
    const nextCount = accepted.length + 1;
    const nextKeyBytes = totalKeyBytes + keyBytesLen;
    if (nextCount > effectiveMaxSlots) {
      breakdown.capacityCapped++;
      continue;
    }
    if (computePoolSabLayout(nextCount, nextKeyBytes).totalBytes > maxMemoryBytes) {
      breakdown.capacityCapped++;
      continue;
    }

    accepted.push({ ...c, y, keyBytesLen });
    totalKeyBytes = nextKeyBytes;
    grid.insert(c.x, c.z, c.footprintRadiusM);

    switch (c.kind) {
      case RespawnKind.Creature:
        byKind.creature++;
        break;
      case RespawnKind.ResourceNode:
        byKind.resourceNode++;
        break;
      case RespawnKind.CivicVein:
        byKind.civicVein++;
        break;
      case RespawnKind.Chest:
        byKind.chest++;
        break;
      case RespawnKind.BreakableProp:
        byKind.breakableProp++;
        break;
      case RespawnKind.Resident:
        byKind.resident++;
        break;
    }
  }

  const pool = SpawnPoolSoA.create({
    capacity: accepted.length,
    keyBufferBytes: totalKeyBytes,
    maxBudgetBytes: maxMemoryBytes,
  });

  for (let i = 0; i < accepted.length; i++) {
    const p = accepted[i]!;
    pool.allocateSlot({
      key: p.key,
      kind: p.kind,
      state: SlotState.Active,
      flags: p.flags,
      modelId: p.modelId,
      archetypeId: p.archetypeId,
      stock: p.stock,
      maxStock: p.maxStock,
      anchorIndex: p.anchorIndex,
      homeX: p.x,
      homeY: p.y,
      homeZ: p.z,
      footprintRadiusM: p.footprintRadiusM,
      respawnDelayMs: p.respawnDelayMs,
    });
  }

  const rejected =
    breakdown.outOfBounds +
    breakdown.exclusionZone +
    breakdown.waterHabitat +
    breakdown.slopeTooSteep +
    breakdown.modelOverlap +
    breakdown.capacityCapped +
    breakdown.duplicateKey;

  const stats = pool.utilizationStats();
  const report: ConstraintReport = {
    totalCandidates: candidates.length,
    accepted: accepted.length,
    rejected,
    breakdown,
    sabBytes: stats.byteLength,
    utilizationPct: stats.utilizationPct,
    modelRadiiResolved,
    resolvedModelRadiiById,
    byKind,
  };

  return { pool, report };
}
