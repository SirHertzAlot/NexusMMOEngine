/**
 * 4-Tier Hierarchical WFC + Continuous Model Building Synthesizer.
 *
 * Consumes a `DecompositionLibrary` produced by `decomposeUnityScene`, plans rooms
 * and interior decoration groupings via `@mmo-engine/wfc` (`solve`), swaps compatible
 * modular style variants safely by exact GLB pivot bounds, guarantees clear walkable
 * corridors between doorways and stairs, and emits `SynthesizedPlacement[]` aligned
 * to `@mmo-engine/settlement` parcels.
 */

import { solve, type WfcOption } from "@mmo-engine/wfc";
import { categorizeDetailedPart, categorizePart, type DetailedPartCategory } from "./extractor.js";
import { solveBuildingRoomPlan, solveRoomVignetteSlots } from "./wfc-bridge.js";
import {
  createParametricTemplateFromPrototype,
  rollLotVariation,
  type LotVariationRoll,
} from "./parametric-template.js";
import {
  runBuildingAdoptionPipeline,
  type BuildingAdoptionResult,
} from "./building-provenance.js";
import type {
  BoundsData,
  BuildingRoomPlan,
  BuildingSynthesisOptions,
  BuildingSynthesisResult,
  DecompositionLibrary,
  DecomposedRoom,
  DecorationGrouping,
  QuatTuple,
  RoomType,
  StructurePrototype,
  SynthesizedPlacement,
  Vec3Tuple,
} from "./types.js";

const r2 = (n: number): number => Math.round(n * 100) / 100 || 0;
const r3 = (n: number): number => Math.round(n * 1000) / 1000 || 0;
const r4 = (n: number): number => Math.round(n * 10000) / 10000 || 0;

interface BoxXZ {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function yawQuat(yawRad: number): QuatTuple {
  const h = yawRad * 0.5;
  return [0, r4(Math.sin(h)), 0, r4(Math.cos(h))];
}

function mulQuat(a: QuatTuple, b: QuatTuple): QuatTuple {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    r4(aw * bx + ax * bw + ay * bz - az * by),
    r4(aw * by - ax * bz + ay * bw + az * bx),
    r4(aw * bz + ax * by - ay * bx + az * bw),
    r4(aw * bw - ax * bx - ay * by - az * bz),
  ];
}

function rotateY(v: Vec3Tuple, rad: number): Vec3Tuple {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [r3(v[0] * c + v[2] * s), r3(v[1]), r3(-v[0] * s + v[2] * c)];
}

function boxesOverlapXZ(a: BoxXZ, b: BoxXZ, gap = 0): boolean {
  return a.minX < b.maxX + gap && a.maxX + gap > b.minX && a.minZ < b.maxZ + gap && a.maxZ + gap > b.minZ;
}

function boxContainsXZ(outer: BoxXZ, inner: BoxXZ, margin = 0): boolean {
  return (
    inner.minX >= outer.minX + margin &&
    inner.maxX <= outer.maxX - margin &&
    inner.minZ >= outer.minZ + margin &&
    inner.maxZ <= outer.maxZ - margin
  );
}

function colliderModeFor(detailed: DetailedPartCategory): SynthesizedPlacement["colliderMode"] {
  switch (detailed) {
    case "roof":
    case "roof_cap":
    case "roof_trim":
    case "door_leaf":
    case "beam":
    case "decor_rug":
    case "decor_wall":
    case "lighting":
    case "clutter_tabletop":
    case "nature":
      return "none";
    case "wall_door":
      return "split-doorway";
    case "floor":
      return "floor";
    case "stairs":
    case "ladder":
      return "stairs";
    default:
      return "solid";
  }
}

function worldBoxXZ(pos: Vec3Tuple, rot: QuatTuple, scale: Vec3Tuple, local?: BoundsData): BoxXZ {
  const b = local ?? { min: [-0.4, 0, -0.4], max: [0.4, 0.8, 0.4], size: [0.8, 0.8, 0.8] };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const [qx, qy, qz, qw] = rot;
  for (const lx of [b.min[0] * scale[0], b.max[0] * scale[0]]) {
    for (const ly of [b.min[1] * scale[1], b.max[1] * scale[1]]) {
      for (const lz of [b.min[2] * scale[2], b.max[2] * scale[2]]) {
        const tx = 2 * (qy * lz - qz * ly);
        const ty = 2 * (qz * lx - qx * lz);
        const tz = 2 * (qx * ly - qy * lx);
        const wx = pos[0] + lx + qw * tx + (qy * tz - qz * ty);
        const wz = pos[2] + lz + qw * tz + (qx * ty - qy * tx);
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      }
    }
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * Settlement kinds a kit may have no building for, and the families that stand in, first found wins: a shop is a
 * house with a counter, a granary a barn, a town hall a hall. Any other kind stands in as a house.
 */
const STAND_INS: Readonly<Record<string, readonly string[]>> = {
  tenement: ["house"], townhouse: ["house"], artisan_house: ["house"], rectory: ["house"], apothecary: ["house"],
  shop: ["house"], bakery: ["house"], master_bakery: ["house"], library: ["house"], farmstead: ["house"],
  master_farmstead: ["house"], school: ["tavern", "house"],
  granary: ["stables", "barn"], warehouse: ["stables", "barn"],
  sawmill: ["workshop", "smithy"], master_smithy: ["smithy"], master_workshop: ["workshop", "smithy"],
  mine: ["shelter", "hut"], fishery: ["hut"], master_fishery: ["hut"],
  guild_hall: ["tavern"], market: ["tavern"], theatre: ["tavern"], bathhouse: ["tavern"], hospital: ["tavern"], town_hall: ["tavern"],
  parish_church: ["church", "chapel"], cathedral: ["church", "chapel"], monastery: ["church", "chapel"],
  watch_hq: ["tower", "guardhouse"], gaol: ["tower", "guardhouse"], barracks: ["tower", "guardhouse"],
};

/** Choose a prototype matching the requested settlement archetype and parcel budget via WFC. */
function selectPrototypeWithWfc(
  library: DecompositionLibrary,
  archetype: string,
  seed: number,
  maxFootprintM?: [number, number],
): StructurePrototype {
  const archLower = archetype.toLowerCase();
  const serving = (kind: string): StructurePrototype[] =>
    library.structures.filter((s) => s.settlementArchetypes.some((a) => a.toLowerCase() === kind) || s.category.toLowerCase() === kind);
  let candidates = serving(archLower);
  for (const kind of [...(STAND_INS[archLower] ?? []), "house"]) {
    if (candidates.length > 0) break;
    candidates = serving(kind);
  }
  if (candidates.length === 0) {
    // Broad fallback when library doesn't carry a specialized structure archetype
    candidates = library.structures.filter((s) => s.hasInterior);
  }
  if (candidates.length === 0) candidates = library.structures;
  if (candidates.length === 0) {
    throw new Error(`DecompositionLibrary has no structures to synthesize archetype "${archetype}"`);
  }

  if (maxFootprintM) {
    const [mw, md] = maxFootprintM;
    const fitting = candidates.filter((c) => c.footprint[0] <= mw + 1.5 && c.footprint[2] <= md + 1.5);
    if (fitting.length > 0) candidates = fitting;
  }

  const options: WfcOption[] = candidates.map((s, idx) => {
    let w = s.hasInterior ? 3.0 : 1.0;
    if (s.rooms.length > 0) w += Math.min(3, s.rooms.length * 0.6);
    if (s.category.toLowerCase() === archLower) w += 2.5;
    if (maxFootprintM) {
      const over = Math.max(0, s.footprint[0] - maxFootprintM[0], s.footprint[2] - maxFootprintM[1]);
      w /= 1 + over * 0.5;
    }
    return { id: String(idx), weight: Math.max(0.05, w) };
  });

  try {
    const sol = solve({ options, slots: 1 }, { seed });
    return candidates[Number(sol.ids[0])] ?? candidates[0];
  } catch {
    return candidates[0];
  }
}

/** Build doorway + stair walk-corridor exclusion boxes inside a room so circulation never blocks. */
function buildWalkCorridors(room: DecomposedRoom): BoxXZ[] {
  const zones: BoxXZ[] = [];
  const clearance = 0.85;
  for (const op of room.openings) {
    const [ox, , oz] = op.localPos;
    zones.push({
      minX: ox - clearance,
      maxX: ox + clearance,
      minZ: oz - clearance,
      maxZ: oz + clearance,
    });
  }

  // Add stepped corridor strip between pairs of openings in the same room
  for (let i = 0; i < room.openings.length; i++) {
    for (let j = i + 1; j < room.openings.length; j++) {
      const a = room.openings[i].localPos;
      const b = room.openings[j].localPos;
      const dist = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const steps = Math.max(2, Math.ceil(dist / 0.75));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[2] + (b[2] - a[2]) * t;
        zones.push({ minX: x - 0.55, maxX: x + 0.55, minZ: z - 0.55, maxZ: z + 0.55 });
      }
    }
  }
  return zones;
}

interface CandidatePose {
  pos: Vec3Tuple;
  yawRad: number;
  wallBacked: boolean;
}

function sampleAxis(lo: number, hi: number, step = 0.5): number[] {
  if (hi <= lo + 0.02) return [r3((lo + hi) / 2)];
  const mid = r3((lo + hi) / 2);
  const count = Math.max(2, Math.ceil((hi - lo) / step));
  const out = [mid];
  const seen = new Set<number>([mid]);
  for (let i = 0; i <= count; i++) {
    const v = r3(lo + (hi - lo) * (i / count));
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function generateRoomPoses(room: DecomposedRoom, anchorBounds?: BoundsData): CandidatePose[] {
  const minX = room.bounds.min[0];
  const maxX = room.bounds.max[0];
  const minZ = room.bounds.min[2];
  const maxZ = room.bounds.max[2];
  const elev = room.elevationY;
  const poses: CandidatePose[] = [];

  const hx = anchorBounds ? Math.max(0.25, (anchorBounds.max[0] - anchorBounds.min[0]) / 2) : 0.55;
  const hz = anchorBounds ? Math.max(0.25, (anchorBounds.max[2] - anchorBounds.min[2]) / 2) : 0.45;
  const wallMarginX = Math.max(0.25, hz + 0.1);
  const wallMarginZ = Math.max(0.25, hz + 0.1);
  const lateralPad = Math.max(0.25, hx + 0.1);
  const margin = 0.06;

  // North & South walls: anchor faces inward along +Z (0) / -Z (PI), width runs along X
  if (maxZ - minZ >= wallMarginZ * 2 + 0.2) {
    const xs = sampleAxis(minX + lateralPad + margin, maxX - lateralPad - margin, 0.5);
    for (const x of xs) {
      poses.push({ pos: [x, elev, r3(minZ + wallMarginZ + margin)], yawRad: 0, wallBacked: true });
      poses.push({ pos: [x, elev, r3(maxZ - wallMarginZ - margin)], yawRad: Math.PI, wallBacked: true });
    }
  }

  // West & East walls: anchor faces inward along +X (PI/2) / -X (-PI/2), width runs along Z
  if (maxX - minX >= wallMarginX * 2 + 0.2) {
    const zs = sampleAxis(minZ + lateralPad + margin, maxZ - lateralPad - margin, 0.5);
    for (const z of zs) {
      poses.push({ pos: [r3(minX + wallMarginX + margin), elev, z], yawRad: Math.PI / 2, wallBacked: true });
      poses.push({ pos: [r3(maxX - wallMarginX - margin), elev, z], yawRad: -Math.PI / 2, wallBacked: true });
    }
  }

  // Interior / center poses radiating outward from room centroid
  const cx = r3((minX + maxX) / 2);
  const cz = r3((minZ + maxZ) / 2);
  const spanX = Math.max(0.5, maxX - minX);
  const spanZ = Math.max(0.5, maxZ - minZ);
  const offsets: Array<[number, number]> = [[0, 0]];
  if (spanX >= 3.2) offsets.push([-0.9, 0], [0.9, 0]);
  if (spanZ >= 3.2) offsets.push([0, -0.9], [0, 0.9]);
  for (const [ox, oz] of offsets) {
    for (const yawRad of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      poses.push({ pos: [r3(cx + ox), elev, r3(cz + oz)], yawRad, wallBacked: false });
    }
  }
  return poses;
}

function appendPrototypeDressing(
  room: DecomposedRoom,
  partMap: DecompositionLibrary["ruleSet"]["parts"],
  walkZones: BoxXZ[],
  occupied: BoxXZ[],
  placements: SynthesizedPlacement[],
): void {
  for (const dp of room.parts) {
    if (dp.layer !== "dressing") continue;
    const detailed = categorizeDetailedPart(dp.partId);
    const pBounds = dp.bounds ?? partMap[dp.partId]?.bounds;
    const mode = colliderModeFor(detailed);
    const bx = worldBoxXZ(dp.transform.pos, dp.transform.rot, dp.transform.scale, pBounds);
    if (mode === "solid" && walkZones.some((wz) => boxesOverlapXZ(wz, bx))) continue;
    if (mode === "solid") occupied.push(bx);
    placements.push({
      partId: dp.partId,
      assetRef: dp.assetRef,
      category: dp.category ?? categorizePart(dp.partId),
      transform: dp.transform,
      size: pBounds?.size ?? [0.8, 0.8, 0.8],
      pivotBounds: pBounds,
      layer: "dressing",
      roomId: room.id,
      storey: room.storey,
      colliderMode: mode,
    });
  }
}

/** Synthesize a single room's furniture/dressing using WFC vignette slots + walk-corridor safety. */
function synthesizeRoomInterior(
  room: DecomposedRoom,
  plannedType: RoomType,
  archetype: string,
  library: DecompositionLibrary,
  density: number,
  seed: number,
): { placements: SynthesizedPlacement[]; vignettesPlaced: string[] } {
  const partMap = library.ruleSet.parts;
  const roomArea = Math.max(2, room.bounds.size[0] * room.bounds.size[2]);
  const maxSlots = Math.max(1, Math.min(5, Math.round((roomArea / 7.5) * density)));

  // Gather candidate vignettes prioritizing exact RoomType match
  let candidates = library.vignettes.filter((v) => v.roomTypes.includes(plannedType));
  if (candidates.length === 0 && room.vignetteRefs.length > 0) {
    const refSet = new Set(room.vignetteRefs);
    candidates = library.vignettes.filter((v) => refSet.has(v.id));
  }
  if (candidates.length === 0) {
    // Broad domestic vignette fallback if specialized room had no extracted groupings
    candidates = library.vignettes.filter((v) =>
      v.roomTypes.includes("living_hall") || v.roomTypes.includes("dining_hall"),
    );
  }

  const chosen = solveRoomVignetteSlots(plannedType, candidates, maxSlots, seed ^ (room.storey * 97));
  const walkZones = buildWalkCorridors(room);
  const occupied: BoxXZ[] = [];
  const roomBox: BoxXZ = {
    minX: room.bounds.min[0],
    maxX: room.bounds.max[0],
    minZ: room.bounds.min[2],
    maxZ: room.bounds.max[2],
  };

  const placements: SynthesizedPlacement[] = [];
  const vignettesPlaced: string[] = [];

  if (chosen.length === 0) {
    appendPrototypeDressing(room, partMap, walkZones, occupied, placements);
    return { placements, vignettesPlaced };
  }

  for (let vi = 0; vi < chosen.length; vi++) {
    const vig = chosen[vi];
    const anchorBounds = partMap[vig.anchorPartId]?.bounds;
    const anchorCat = categorizeDetailedPart(vig.anchorPartId);
    const poses = generateRoomPoses(room, anchorBounds);
    const orderedPoses = [...poses].sort((a, b) => {
      if (vig.placementPreference === "wall_backed") return (b.wallBacked ? 1 : 0) - (a.wallBacked ? 1 : 0);
      if (vig.placementPreference === "center") return (a.wallBacked ? 1 : 0) - (b.wallBacked ? 1 : 0);
      return 0;
    });

    // Deterministic start cursor by vignette index & seed
    const offsetIdx = ((seed >>> 0) + vi * 7) % Math.max(1, orderedPoses.length);
    for (let step = 0; step < orderedPoses.length; step++) {
      const pose = orderedPoses[(step + offsetIdx) % orderedPoses.length];
      if (vig.placementPreference === "center" && pose.wallBacked && orderedPoses.some((p) => !p.wallBacked)) {
        continue;
      }

      const anchorQ = yawQuat(pose.yawRad);
      const anchorScale: Vec3Tuple = [1, 1, 1];
      const anchorY = r3(room.elevationY - Math.min(0, anchorBounds?.min[1] ?? 0));
      const anchorPos: Vec3Tuple = [pose.pos[0], anchorY, pose.pos[2]];
      const anchorBox = worldBoxXZ(anchorPos, anchorQ, anchorScale, anchorBounds);

      if (!boxContainsXZ(roomBox, anchorBox, -0.02)) continue;
      if (walkZones.some((wz) => boxesOverlapXZ(wz, anchorBox))) continue;
      if (occupied.some((ob) => boxesOverlapXZ(ob, anchorBox, 0.15))) continue;

      // Test satellite children fit inside room without blocking doorways/other furniture
      const childPlacements: SynthesizedPlacement[] = [];
      const childBoxes: BoxXZ[] = [];
      let blockedRequired = false;

      for (const item of vig.items) {
        const wOff = rotateY(item.offset, pose.yawRad);
        const childPos: Vec3Tuple = [
          r3(anchorPos[0] + wOff[0]),
          item.relation === "under"
            ? r3(room.elevationY + 0.01)
            : r3(anchorPos[1] + wOff[1]),
          r3(anchorPos[2] + wOff[2]),
        ];
        const childRot = mulQuat(anchorQ, item.quat);
        const childBounds = partMap[item.partId]?.bounds;
        const cCat = categorizeDetailedPart(item.partId);
        const cMode = colliderModeFor(cCat);
        const cBox = worldBoxXZ(childPos, childRot, item.scale, childBounds);

        const isBlockingCollider = cMode === "solid";
        const outside = !boxContainsXZ(roomBox, cBox, 0.02);
        const hitsWalk = isBlockingCollider && walkZones.some((wz) => boxesOverlapXZ(wz, cBox));
        const hitsObs = isBlockingCollider && occupied.some((ob) => boxesOverlapXZ(ob, cBox, 0.12));

        if (outside || hitsWalk || hitsObs) {
          if (item.required) {
            blockedRequired = true;
            break;
          }
          continue;
        }
        if (isBlockingCollider) childBoxes.push(cBox);

        childPlacements.push({
          partId: item.partId,
          assetRef: item.assetRef,
          category: item.category,
          transform: { pos: childPos, rot: childRot, scale: [...item.scale] },
          size: childBounds
            ? [r3(childBounds.size[0] * item.scale[0]), r3(childBounds.size[1] * item.scale[1]), r3(childBounds.size[2] * item.scale[2])]
            : [0.5, 0.5, 0.5],
          pivotBounds: childBounds,
          layer: "dressing",
          roomId: room.id,
          storey: room.storey,
          colliderMode: cMode,
        });
      }

      if (blockedRequired) continue;

      // Commit anchor + valid vignette children
      occupied.push(anchorBox, ...childBoxes);
      const isVendorCounter =
        (anchorCat === "furniture_bar" || (anchorCat === "furniture_table" && vig.kind === "bar_service")) &&
        (archetype === "tavern" || archetype === "inn" || archetype === "shop" || archetype === "smithy" || archetype === "bakery");

      placements.push({
        partId: vig.anchorPartId,
        assetRef: vig.anchorAssetRef,
        category: vig.anchorCategory,
        transform: { pos: anchorPos, rot: anchorQ, scale: anchorScale },
        size: anchorBounds?.size ?? [1.2, 0.9, 0.8],
        pivotBounds: anchorBounds,
        layer: "dressing",
        roomId: room.id,
        storey: room.storey,
        colliderMode: colliderModeFor(anchorCat),
        ...(isVendorCounter ? { interaction: { kind: "vendor" } } : anchorCat === "furniture_chest" ? { interaction: { kind: "chest" } } : {}),
      });
      placements.push(...childPlacements);
      vignettesPlaced.push(vig.id);
      break;
    }
  }

  if (placements.length === 0) {
    appendPrototypeDressing(room, partMap, walkZones, occupied, placements);
  }
  return { placements, vignettesPlaced };
}

/**
 * Synthesize a complete multi-part, enterable building with WFC-planned rooms and
 * interior decoration vignettes matching `opts.archetype` and `opts.seed`.
 */
export function synthesizeBuilding(
  library: DecompositionLibrary,
  opts: BuildingSynthesisOptions,
): BuildingSynthesisResult {
  const startMs = Date.now();
  const wantsAdoption = Boolean(
    opts.parametricTemplate ||
    opts.weatheringInputs ||
    (opts.spilloverLayers && opts.spilloverLayers.length > 0) ||
    opts.emitProvenance,
  );
  const preRoll: LotVariationRoll | undefined = opts.parametricTemplate
    ? rollLotVariation(opts.parametricTemplate, {
        seed: opts.seed,
        parcelSizeM: opts.maxFootprintM,
        district: opts.district,
        overrides: opts.knobOverrides,
      })
    : undefined;
  const effectiveMaxFootprintM: [number, number] | undefined = preRoll
    ? opts.maxFootprintM
      ? [
          Math.min(opts.maxFootprintM[0], preRoll.rolledFootprintM[0]),
          Math.min(opts.maxFootprintM[1], preRoll.rolledFootprintM[1]),
        ]
      : preRoll.rolledFootprintM
    : opts.maxFootprintM;

  const proto = selectPrototypeWithWfc(library, opts.archetype, opts.seed, effectiveMaxFootprintM);
  const rolledDensity =
    preRoll && typeof preRoll.knobValues.dressingDensity === "number"
      ? preRoll.knobValues.dressingDensity
      : undefined;
  const density = opts.dressingDensity ?? rolledDensity ?? 0.75;
  const synthesizeInteriors = opts.synthesizeInteriors ?? true;
  const yawRad = ((opts.frontYawDeg ?? 0) * Math.PI) / 180;
  const rotQ = yawQuat(yawRad);

  // Uniform XZ plot scale if structure slightly exceeds plot bounds (never squash height below 0.9m factor)
  let fitXZ = 1;
  if (effectiveMaxFootprintM) {
    const [mw, md] = effectiveMaxFootprintM;
    const ratio = Math.min(mw / Math.max(0.5, proto.footprint[0]), md / Math.max(0.5, proto.footprint[2]));
    if (ratio < 1) {
      fitXZ = Math.max(0.78, ratio);
    }
  }
  const fitY = fitXZ < 1 ? Math.max(0.92, fitXZ) : 1;

  // Plan RoomTypes via @mmo-engine/wfc
  const plannedTypes = solveBuildingRoomPlan(proto, library, opts.archetype, opts.seed, opts.pinRooms);

  const partMap = library.ruleSet.parts;
  const rawPlacements: SynthesizedPlacement[] = [];
  const categoryCounts: Record<string, number> = {};

  // 1. Emit structural exterior, plinth, floors, stairs, doors, roofs
  for (const p of proto.parts) {
    if (p.layer === "dressing" && synthesizeInteriors) continue;
    const detailed = categorizeDetailedPart(p.partId);
    const bounds = p.bounds ?? partMap[p.partId]?.bounds;
    const mode = colliderModeFor(detailed);
    const sx = r2(p.transform.scale[0] * fitXZ);
    const sy = r2(p.transform.scale[1] * fitY);
    const sz = r2(p.transform.scale[2] * fitXZ);
    const pos: Vec3Tuple = [r3(p.transform.pos[0] * fitXZ), r3(p.transform.pos[1] * fitY), r3(p.transform.pos[2] * fitXZ)];
    rawPlacements.push({
      partId: p.partId,
      assetRef: p.assetRef,
      category: p.category ?? categorizePart(p.partId),
      transform: { pos, rot: [...p.transform.rot], scale: [sx, sy, sz] },
      size: bounds
        ? [r3(bounds.size[0] * sx), r3(bounds.size[1] * sy), r3(bounds.size[2] * sz)]
        : [2.5, 2.5, 2.5],
      pivotBounds: bounds,
      layer: p.layer,
      roomId: p.roomId,
      storey: p.storey,
      colliderMode: mode,
      ...(detailed === "door_leaf" ? { interaction: { kind: "door" } } : {}),
    });
  }

  // 2. Emit synthesized interior dressing vignettes per room
  const roomPlans: BuildingRoomPlan[] = [];
  for (let i = 0; i < proto.rooms.length; i++) {
    const rm = proto.rooms[i];
    const scaledRoom: DecomposedRoom =
      fitXZ === 1 && fitY === 1
        ? rm
        : {
            ...rm,
            elevationY: r3(rm.elevationY * fitY),
            bounds: {
              min: [r3(rm.bounds.min[0] * fitXZ), r3(rm.bounds.min[1] * fitY), r3(rm.bounds.min[2] * fitXZ)],
              max: [r3(rm.bounds.max[0] * fitXZ), r3(rm.bounds.max[1] * fitY), r3(rm.bounds.max[2] * fitXZ)],
              size: [r3(rm.bounds.size[0] * fitXZ), r3(rm.bounds.size[1] * fitY), r3(rm.bounds.size[2] * fitXZ)],
            },
            openings: rm.openings.map((op) => ({
              ...op,
              localPos: [r3(op.localPos[0] * fitXZ), r3(op.localPos[1] * fitY), r3(op.localPos[2] * fitXZ)],
            })),
          };
    const plannedType = plannedTypes[i] ?? rm.roomType;
    let vignettesPlaced: string[] = [];

    if (synthesizeInteriors) {
      const res = synthesizeRoomInterior(scaledRoom, plannedType, opts.archetype, library, density, opts.seed + i * 131);
      rawPlacements.push(...res.placements);
      vignettesPlaced = res.vignettesPlaced;
    } else {
      vignettesPlaced = [...rm.vignetteRefs];
    }

    roomPlans.push({
      roomId: rm.id,
      roomType: plannedType,
      storey: rm.storey,
      elevationY: scaledRoom.elevationY,
      bounds: scaledRoom.bounds,
      vignettesPlaced,
    });
  }

  // 3. Apply final building yaw rotation (`frontYawDeg`) around canonical origin (0, 0, 0)
  const finalPlacements: SynthesizedPlacement[] = rawPlacements.map((pl) => {
    const wPos = yawRad !== 0 ? rotateY(pl.transform.pos, yawRad) : pl.transform.pos;
    const wRot = yawRad !== 0 ? mulQuat(rotQ, pl.transform.rot) : pl.transform.rot;
    categoryCounts[pl.category] = (categoryCounts[pl.category] ?? 0) + 1;
    return {
      ...pl,
      transform: {
        pos: wPos,
        rot: wRot,
        scale: pl.transform.scale,
      },
    };
  });

  const footprint: Vec3Tuple = [
    r3(proto.footprint[0] * fitXZ),
    r3(proto.footprint[1] * fitY),
    r3(proto.footprint[2] * fitXZ),
  ];

  let adoption: BuildingAdoptionResult | undefined;
  if (wantsAdoption) {
    const template =
      opts.parametricTemplate ??
      createParametricTemplateFromPrototype({
        prototype: proto,
        id: `auto-${proto.id}`,
        family: proto.category,
      });
    const weatheringInputs = opts.weatheringInputs ?? {
      moisture: 0.25,
      aspectDeg: opts.frontYawDeg ?? 0,
      buildingAgeYears: 0,
      groundY: 0,
      seed: opts.seed,
    };
    adoption = runBuildingAdoptionPipeline({
      buildingId: opts.buildingId ?? `${opts.archetype}-${opts.seed}`,
      archetype: opts.archetype,
      template,
      seed: opts.seed,
      parcelSizeM: opts.maxFootprintM,
      district: opts.district,
      overrides: opts.knobOverrides,
      preRolledVariation: preRoll,
      weatheringInputs,
      placements: finalPlacements,
      adjacentStructures: opts.adjacentStructures,
      spilloverLayers: opts.spilloverLayers,
      tierScale: opts.detailTierScale,
    });
  }

  return {
    archetype: opts.archetype,
    prototypeId: proto.id,
    structureCategory: proto.category,
    footprint,
    groundY: 0,
    rooms: roomPlans,
    placements: finalPlacements,
    report: {
      partsPlaced: finalPlacements.length,
      growthAttempts: finalPlacements.length,
      unfilledSockets: 0,
      elapsedMs: Math.max(0, Date.now() - startMs),
      ruleSetVersion: library.extractorVersion,
      categoryCounts,
      roomsPlanned: roomPlans.length,
      vignettesPlaced: roomPlans.reduce((s, r) => s + r.vignettesPlaced.length, 0),
      wfcRestarts: 0,
    },
    ...(adoption ? { adoption } : {}),
  };
}

/** Convenience entry point tailored for @mmo-engine/settlement parcel sizing (width/depth in metres, yaw in radians). */
export function synthesizeBuildingForParcel(
  library: DecompositionLibrary,
  archetype: string,
  parcelWidthM: number,
  parcelDepthM: number,
  facingYawRad: number,
  seed: number,
  opts: Omit<BuildingSynthesisOptions, "archetype" | "seed" | "maxFootprintM" | "frontYawDeg"> = {},
): BuildingSynthesisResult {
  return synthesizeBuilding(library, {
    ...opts,
    archetype,
    seed,
    maxFootprintM: [parcelWidthM, parcelDepthM],
    frontYawDeg: (facingYawRad * 180) / Math.PI,
  });
}
