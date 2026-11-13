/**
 * 4-Tier Hierarchical Unity Scene Decomposer.
 *
 * Transforms flat parsed Unity scenes (`UnityRawNode[]`) + GLB pivot bounds into
 * a structured `DecompositionLibrary` matching MODEL-SYNTHESIS-MAP.md:
 *   Tier 1: Structure archetypes (`house`, `tavern`, `smithy`, `chapel`, ...)
 *   Tier 2: Room types & storey grids (`taproom`, `bedroom`, `kitchen_hearth`, ...)
 *   Tier 3: Decoration groupings / vignettes (`table + chairs + vessels`, `bar + stools`, ...)
 *   Tier 4: Modular part adjacency rules & sockets (`LearnedRuleSet`)
 */

import type { CatalogModelBounds } from "./glb-bounds.js";
import { categorizeDetailedPart, categorizePart, extractLearnedRuleSet, type DetailedPartCategory } from "./extractor.js";
import type { UnityRawNode } from "./unity-parser.js";
import type {
  ArchitecturalLayer,
  BoundsData,
  DecompositionLibrary,
  DecomposedRoom,
  DecorationGrouping,
  ExampleAssembly,
  LearnedRuleSet,
  PlacedPartInstance,
  QuatTuple,
  RoomOpening,
  RoomType,
  StoreyCell,
  StoreySlice,
  StoreyWallEdge,
  StructureCategory,
  StructurePrototype,
  TransformData,
  Vec3Tuple,
  VignetteItem,
  VignetteRelation,
  VignetteRole,
} from "./types.js";

export interface DecomposeUnityOptions {
  family?: string;
  sourceName?: string;
  license?: string;
  /** Default pack prefix when building assetRef if catalogBounds doesn't contain partId. */
  assetPrefix?: string;
  /** Optional catalog GLB pivot-relative bounds lookup (from `loadCatalogPartBounds`). */
  catalogBounds?: Map<string, CatalogModelBounds>;
  /** Horizontal modular grid unit in metres (default 2.5m for Synty kits). */
  cellSizeM?: number;
  /** Typical storey vertical rise in metres (default 2.5m). */
  floorHeightM?: number;
  /** Max XZ distance in metres to associate loose Interior/Props nodes to a structure shell. */
  mergeInteriorRadiusM?: number;
  /** Minimum architectural part count for a group to qualify as a structure (default 3). */
  minStructureParts?: number;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000 || 0;
const r4 = (n: number): number => Math.round(n * 10000) / 10000 || 0;
const r2 = (n: number): number => Math.round(n * 100) / 100 || 0;

function rotateVecY(v: Vec3Tuple, yawRad: number): Vec3Tuple {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

function rotateVecByQuat(v: Vec3Tuple, q: readonly [number, number, number, number]): Vec3Tuple {
  const [vx, vy, vz] = v;
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
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

function yawQuat(yawRad: number): QuatTuple {
  const h = yawRad * 0.5;
  return [0, r4(Math.sin(h)), 0, r4(Math.cos(h))];
}

function quatYawDeg(q: QuatTuple): number {
  const [qx, qy, qz, qw] = q;
  const siny = 2 * (qw * qy + qx * qz);
  const cosy = 1 - 2 * (qy * qy + qz * qz);
  return (Math.atan2(siny, cosy) * 180) / Math.PI;
}

function snap90Deg(deg: number): number {
  let d = Math.round(deg / 90) * 90;
  d = ((d + 180) % 360 + 360) % 360 - 180;
  if (d <= -180) d += 360;
  return d === 0 ? 0 : d;
}

function worldBoundsOfPart(pos: Vec3Tuple, rot: QuatTuple, scale: Vec3Tuple, local: BoundsData): BoundsData {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const lx of [local.min[0] * scale[0], local.max[0] * scale[0]]) {
    for (const ly of [local.min[1] * scale[1], local.max[1] * scale[1]]) {
      for (const lz of [local.min[2] * scale[2], local.max[2] * scale[2]]) {
        const w = rotateVecByQuat([lx, ly, lz], rot);
        const wx = pos[0] + w[0];
        const wy = pos[1] + w[1];
        const wz = pos[2] + w[2];
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      }
    }
  }
  return {
    min: [r3(minX), r3(minY), r3(minZ)],
    max: [r3(maxX), r3(maxY), r3(maxZ)],
    size: [r3(maxX - minX), r3(maxY - minY), r3(maxZ - minZ)],
  };
}

function defaultBoundsFor(cat: DetailedPartCategory): BoundsData {
  const sz: Vec3Tuple =
    cat === "floor" || cat === "ceiling" ? [2.5, 0.16, 2.5]
    : cat === "wall" || cat === "wall_door" || cat === "wall_window" ? [2.5, 2.5, 0.25]
    : cat === "plinth" ? [2.5, 1.25, 0.65]
    : cat === "stairs" ? [2.5, 2.5, 2.5]
    : cat === "furniture_table" || cat === "furniture_bar" ? [1.6, 0.9, 1.2]
    : cat === "furniture_bed" ? [1.4, 0.9, 2.2]
    : cat === "furniture_storage" || cat === "fixture_hearth" ? [1.2, 1.6, 0.7]
    : cat === "furniture_seat" || cat === "furniture_chest" ? [0.65, 0.65, 0.65]
    : cat === "decor_rug" ? [2.0, 0.05, 1.5]
    : cat === "clutter_tabletop" || cat === "lighting" ? [0.3, 0.35, 0.3]
    : [1.0, 1.0, 1.0];
  return {
    min: [r3(-sz[0] / 2), 0, r3(-sz[2] / 2)],
    max: [r3(sz[0] / 2), r3(sz[1]), r3(sz[2] / 2)],
    size: sz,
  };
}

const GENERIC_CONTAINERS = new Set([
  "sceneroot", "buildings", "building", "architecture", "structures", "props",
  "interiors", "interior", "exteriors", "exterior", "layout", "environment",
  "world", "town", "village", "city", "demo", "preset", "presets", "grp", "group",
  "other", "weapons", "vehicles", "castle_interior_dressing", "castle_exterior_dressing",
  "battle_dressing", "preset_buildings_group", "preset_buildings_optimized", "castle_wall_group",
]);

function isContainerFolder(lower: string): boolean {
  return (
    GENERIC_CONTAINERS.has(lower) ||
    lower.endsWith("_group") ||
    lower.endsWith("_optimized") ||
    lower.endsWith("_dressing") ||
    lower.endsWith("_layout")
  );
}

function isPartLeaf(seg: string, index: number, total: number, nodeName: string): boolean {
  if (/^(sm|fx|chr|veh|wep|sp)_/i.test(seg)) return true;
  return total > 1 && index === total - 1 && seg === nodeName;
}

function isStructuralCategory(cat: DetailedPartCategory): boolean {
  return (
    cat === "wall" ||
    cat === "wall_door" ||
    cat === "wall_window" ||
    cat === "wall_peak" ||
    cat === "wall_cut" ||
    cat === "floor" ||
    cat === "roof" ||
    cat === "plinth"
  );
}

function isRoofCategory(cat: DetailedPartCategory): boolean {
  return cat === "roof" || cat === "roof_cap" || cat === "roof_trim" || cat === "chimney";
}

function isDressingCategory(cat: DetailedPartCategory): boolean {
  return (
    cat === "furniture_table" ||
    cat === "furniture_seat" ||
    cat === "furniture_bed" ||
    cat === "furniture_bar" ||
    cat === "furniture_storage" ||
    cat === "furniture_chest" ||
    cat === "fixture_hearth" ||
    cat === "lighting" ||
    cat === "decor_rug" ||
    cat === "decor_wall" ||
    cat === "clutter_tabletop" ||
    cat === "clutter_floor"
  );
}

/** Extract the meaningful top-level structure group name from a node's hierarchy path. */
function resolveStructureGroupKey(node: UnityRawNode): { key: string; isLooseContainer: boolean } {
  const segments = node.groupPath.split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const lower = seg.toLowerCase();
    if (isContainerFolder(lower)) continue;
    if (isPartLeaf(seg, i, segments.length, node.name)) break;
    if (
      lower.startsWith("preset_") ||
      lower.includes("house") ||
      lower.includes("tavern") ||
      lower.includes("inn") ||
      lower.includes("smithy") ||
      lower.includes("blacksmith") ||
      lower.includes("shop") ||
      lower.includes("church") ||
      lower.includes("chapel") ||
      lower.includes("windmill") ||
      lower.includes("mill") ||
      lower.includes("castle") ||
      lower.includes("tower") ||
      lower.includes("stable") ||
      lower.includes("barracks") ||
      lower.includes("granary") ||
      lower.includes("outhouse") ||
      lower.includes("warehouse") ||
      lower.includes("bakery") ||
      lower.includes("hut") ||
      lower.includes("shelter") ||
      lower.includes("bld") ||
      lower.includes("building")
    ) {
      return { key: seg, isLooseContainer: false };
    }
    if (i < segments.length - 1) {
      return { key: seg, isLooseContainer: false };
    }
  }
  const top = node.rootGroup || segments[0] || "SceneRoot";
  if (isContainerFolder(top.toLowerCase())) {
    const specific = segments.find(
      (s, idx) => !isContainerFolder(s.toLowerCase()) && !isPartLeaf(s, idx, segments.length, node.name),
    );
    if (specific) {
      return { key: specific, isLooseContainer: false };
    }
    return { key: top, isLooseContainer: true };
  }
  if (/^(sm|fx|chr|veh|wep|sp)_/i.test(top)) {
    return { key: "SceneRoot", isLooseContainer: true };
  }
  return { key: top, isLooseContainer: false };
}

/** Tier 1: classify structure archetype from group name and contained parts. */
export function classifyStructureCategory(
  name: string,
  parts: Array<{ partId: string; detailed: DetailedPartCategory }>,
): StructureCategory {
  const n = name.toLowerCase();
  if (n.includes("tavern")) return "tavern";
  if (n.includes("inn")) return "inn";
  if (n.includes("blacksmith") || n.includes("smithy") || n.includes("forge")) return "smithy";
  if (n.includes("bakery")) return "bakery";
  if (n.includes("workshop")) return "workshop";
  if (n.includes("shop") || n.includes("store") || n.includes("market")) return "shop";
  if (n.includes("chapel")) return "chapel";
  if (n.includes("church") || n.includes("cathedral")) return "church";
  if (n.includes("windmill")) return "windmill";
  if (n.includes("mill")) return "mill";
  if (n.includes("granary")) return "granary";
  if (n.includes("stable")) return "stables";
  if (n.includes("watchtower") || n.includes("tower")) return "tower";
  if (n.includes("guardhouse") || n.includes("gatehouse")) return "guardhouse";
  if (n.includes("barracks")) return "barracks";
  if (n.includes("outhouse")) return "outhouse";
  if (n.includes("warehouse")) return "warehouse";
  if (n.includes("library")) return "library";
  if (n.includes("castle") || n.includes("keep")) return "castle";
  if (n.includes("townhouse") || n.includes("manor")) return "townhouse";
  if (n.includes("hut") || n.includes("shack")) return "hut";
  if (n.includes("shelter") || n.includes("tent")) return "shelter";
  if (n.includes("house")) return "house";

  // Infer from part composition only when the group name itself is generic (e.g. "Building_A")
  const joined = parts.map((p) => p.partId.toLowerCase()).join(" ");
  if (joined.includes("anvil") || joined.includes("bellows") || joined.includes("forge")) return "smithy";
  if (joined.includes("bar_") || joined.includes("_bar") || (joined.includes("mug") && joined.includes("barrel"))) return "tavern";
  if (joined.includes("pew") || joined.includes("altar")) return "chapel";
  if (joined.includes("windmill")) return "windmill";
  if (joined.includes("trough") || joined.includes("stall")) return "stables";
  if (joined.includes("house_") || joined.includes("bld_")) return "house";
  return "unknown";
}

/** Map detailed StructureCategory onto @mmo-engine/settlement archetype names. */
export function settlementArchetypesFor(cat: StructureCategory): string[] {
  switch (cat) {
    case "tavern": return ["tavern", "inn"];
    case "inn": return ["inn", "tavern"];
    case "smithy": return ["smithy", "forge", "workshop"];
    case "bakery": return ["bakery", "shop"];
    case "workshop": return ["workshop", "smithy"];
    case "shop": return ["shop", "market", "bakery"];
    case "chapel": return ["chapel", "church", "shrine"];
    case "church": return ["church", "chapel", "temple"];
    case "windmill": return ["windmill", "mill"];
    case "mill": return ["mill", "windmill"];
    case "granary": return ["granary", "warehouse", "barn"];
    case "stables": return ["stables", "barn"];
    case "tower": return ["tower", "watchtower", "guardhouse"];
    case "guardhouse": return ["guardhouse", "barracks", "gatehouse"];
    case "barracks": return ["barracks", "guardhouse"];
    case "warehouse": return ["warehouse", "granary"];
    case "library": return ["library", "study", "shop"];
    case "castle": return ["castle", "keep", "manor"];
    case "townhouse": return ["townhouse", "house", "manor"];
    case "hut": return ["hut", "house", "cottage"];
    case "shelter": return ["shelter", "hut"];
    case "outhouse": return ["outhouse"];
    case "house": return ["house", "cottage", "home"];
    default: return ["house"];
  }
}

interface InternalPart {
  raw: UnityRawNode;
  partId: string;
  assetRef: string;
  detailed: DetailedPartCategory;
  coarse: string;
  bounds: BoundsData;
  pos: Vec3Tuple;
  rot: QuatTuple;
  scale: Vec3Tuple;
  worldBox: BoundsData;
  layer: ArchitecturalLayer;
  storey: number;
  roomId?: string;
}

/** Compute front door outward yaw (in normalized engine space) and canonicalize all parts so front faces +Z, XZ centered, base grounded at y=0. */
function canonicalizeStructureParts(
  parts: InternalPart[],
): { frontYawDeg: number; footprint: Vec3Tuple; groundY: number } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of parts) {
    if (p.worldBox.min[0] < minX) minX = p.worldBox.min[0];
    if (p.worldBox.min[1] < minY) minY = p.worldBox.min[1];
    if (p.worldBox.min[2] < minZ) minZ = p.worldBox.min[2];
    if (p.worldBox.max[0] > maxX) maxX = p.worldBox.max[0];
    if (p.worldBox.max[1] > maxY) maxY = p.worldBox.max[1];
    if (p.worldBox.max[2] > maxZ) maxZ = p.worldBox.max[2];
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  // Ground Y comes from lowest plinth / stairs / wall_door / floor base
  let groundY = minY;
  const plinthAndWalls = parts.filter((p) => p.detailed === "plinth" || p.detailed === "wall" || p.detailed === "wall_door" || p.detailed === "stairs");
  if (plinthAndWalls.length > 0) {
    groundY = Math.min(...plinthAndWalls.map((p) => p.worldBox.min[1]));
  }

  // Find front entrance: lowest wall_door / door_leaf facing outward from building center
  const doors = parts
    .filter((p) => p.detailed === "wall_door" || p.detailed === "door_leaf")
    .sort((a, b) => a.worldBox.min[1] - b.worldBox.min[1]);

  let frontYawDeg = 0;
  if (doors.length > 0) {
    const mainDoor = doors[0];
    const dcx = (mainDoor.worldBox.min[0] + mainDoor.worldBox.max[0]) / 2 - cx;
    const dcz = (mainDoor.worldBox.min[2] + mainDoor.worldBox.max[2]) / 2 - cz;
    if (Math.hypot(dcx, dcz) > 0.25) {
      const outDeg = (Math.atan2(dcx, dcz) * 180) / Math.PI;
      frontYawDeg = snap90Deg(outDeg);
    } else {
      frontYawDeg = snap90Deg(quatYawDeg(mainDoor.rot));
    }
  }

  // Rotate around Y by -frontYawDeg so front faces +Z
  const deltaRad = (-frontYawDeg * Math.PI) / 180;
  const deltaQ = yawQuat(deltaRad);

  let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
  let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
  for (const p of parts) {
    const rel: Vec3Tuple = [p.pos[0] - cx, p.pos[1] - groundY, p.pos[2] - cz];
    const rotPos = rotateVecY(rel, deltaRad);
    p.pos = [r3(rotPos[0]), r3(rotPos[1]), r3(rotPos[2])];
    p.rot = mulQuat(deltaQ, p.rot);
    p.worldBox = worldBoundsOfPart(p.pos, p.rot, p.scale, p.bounds);
    if (p.worldBox.min[0] < cMinX) cMinX = p.worldBox.min[0];
    if (p.worldBox.min[1] < cMinY) cMinY = p.worldBox.min[1];
    if (p.worldBox.min[2] < cMinZ) cMinZ = p.worldBox.min[2];
    if (p.worldBox.max[0] > cMaxX) cMaxX = p.worldBox.max[0];
    if (p.worldBox.max[1] > cMaxY) cMaxY = p.worldBox.max[1];
    if (p.worldBox.max[2] > cMaxZ) cMaxZ = p.worldBox.max[2];
  }

  // Re-center exact canonical XZ midpoint around (0, 0) after rotation
  const recX = (cMinX + cMaxX) / 2;
  const recZ = (cMinZ + cMaxZ) / 2;
  if (Math.abs(recX) > 1e-4 || Math.abs(recZ) > 1e-4) {
    for (const p of parts) {
      p.pos = [r3(p.pos[0] - recX), p.pos[1], r3(p.pos[2] - recZ)];
      p.worldBox = worldBoundsOfPart(p.pos, p.rot, p.scale, p.bounds);
    }
  }

  return {
    frontYawDeg,
    footprint: [r3(cMaxX - cMinX), r3(cMaxY - cMinY), r3(cMaxZ - cMinZ)],
    groundY: 0,
  };
}

/** Compute modular alignment phase in [0, cellSize) for grid origin alignment. */
function computeGridOriginXZ(parts: InternalPart[], cellSize: number): [number, number] {
  const floors = parts.filter((p) => p.detailed === "floor");
  if (floors.length > 0) {
    const f = floors[0];
    // Floor pivot min aligns cleanly on grid multiples
    const ox = Math.floor(Math.min(...floors.map((p) => p.worldBox.min[0])) / cellSize) * cellSize;
    const oz = Math.floor(Math.min(...floors.map((p) => p.worldBox.min[2])) / cellSize) * cellSize;
    // Adjust fraction from primary floor tile
    const fx = ((f.worldBox.min[0] % cellSize) + cellSize) % cellSize;
    const fz = ((f.worldBox.min[2] % cellSize) + cellSize) % cellSize;
    const minX = Math.min(...parts.map((p) => p.worldBox.min[0]));
    const minZ = Math.min(...parts.map((p) => p.worldBox.min[2]));
    const baseOx = Math.floor((minX - fx) / cellSize) * cellSize + fx;
    const baseOz = Math.floor((minZ - fz) / cellSize) * cellSize + fz;
    return [r3(Math.min(ox, baseOx)), r3(Math.min(oz, baseOz))];
  }
  const minX = Math.min(...parts.map((p) => p.worldBox.min[0]));
  const minZ = Math.min(...parts.map((p) => p.worldBox.min[2]));
  return [r3(minX), r3(minZ)];
}

/** Cluster vertical storey elevations from floor slabs (or walls if unfloored). */
function detectStoreyElevations(parts: InternalPart[], floorHeightM: number): number[] {
  const floorYs = parts
    .filter((p) => p.detailed === "floor")
    .map((p) => r3(p.worldBox.max[1]))
    .sort((a, b) => a - b);

  const levels: number[] = [];
  for (const y of floorYs) {
    if (levels.length === 0 || y - levels[levels.length - 1] > floorHeightM * 0.45) {
      levels.push(y);
    }
  }
  if (levels.length > 0) return levels;

  // Fallback for open-floor sheds / tents: infer ground level from lowest wall bottom
  const wallMins = parts
    .filter((p) => p.detailed === "wall" || p.detailed === "wall_door" || p.detailed === "wall_window")
    .map((p) => p.worldBox.min[1]);
  if (wallMins.length > 0) return [r3(Math.min(...wallMins))];
  return [0];
}

function assignStoreyIndex(part: InternalPart, levels: number[], floorHeightM: number): number {
  const refY =
    part.detailed === "floor"
      ? part.worldBox.max[1]
      : part.detailed === "stairs"
        ? part.worldBox.min[1] + 0.1
        : part.worldBox.min[1] + Math.min(0.25, part.worldBox.size[1] * 0.35);

  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const d = Math.abs(refY - levels[i]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  if (part.detailed === "plinth" || (part.detailed === "stairs" && part.worldBox.min[1] < levels[0] - 0.35)) {
    return 0;
  }
  if (isRoofCategory(part.detailed)) {
    // Roof rests atop highest floor band
    return Math.max(0, Math.min(levels.length - 1, Math.round((part.worldBox.min[1] - levels[0]) / floorHeightM)));
  }
  return best;
}

/** Tier 2: score room type from its contained furniture, props, and structure archetype. */
export function classifyRoomType(
  roomParts: InternalPart[],
  structureCat: StructureCategory,
  storey: number,
  totalStoreys: number,
): RoomType {
  const scores: Partial<Record<RoomType, number>> = {};
  const add = (rt: RoomType, w: number) => {
    scores[rt] = (scores[rt] ?? 0) + w;
  };

  let tables = 0;
  let seats = 0;
  let beds = 0;
  let storageContainers = 0;
  let booksOrScrolls = 0;
  let cookingGear = 0;
  let smithingGear = 0;

  for (const p of roomParts) {
    const id = p.partId.toLowerCase();
    const cat = p.detailed;

    if (cat === "furniture_bar") add("taproom", 8);
    if (cat === "furniture_bed") { beds++; add("bedroom", 10); }
    if (cat === "furniture_table") tables++;
    if (cat === "furniture_seat") seats++;
    if (id.includes("pew") || id.includes("altar") || id.includes("lectern")) add("chapel_nave", 10);
    if (id.includes("bookcase") || id.includes("bookshelf")) { booksOrScrolls += 3; add("study_library", 6); }
    if (id.includes("book") || id.includes("scroll") || id.includes("parchment") || id.includes("ink")) { booksOrScrolls++; add("study_library", 2); }
    if (id.includes("desk")) add("study_library", 3);
    if (id.includes("wargame") || id.includes("map")) add("war_room", 7);
    if (id.includes("anvil") || id.includes("forge") || id.includes("bellows") || id.includes("grindstone")) {
      smithingGear++;
      add("smithy_forge", 10);
    }
    if (id.includes("stove") || id.includes("cauldron") || id.includes("oven") || id.includes("pot_") || id.includes("pig") || id.includes("bread")) {
      cookingGear++;
      add("kitchen_hearth", 5);
    }
    if (cat === "fixture_hearth") add("kitchen_hearth", 2);
    if (id.includes("trough") || id.includes("hay") || id.includes("stall")) add("stable_bay", 9);
    if (id.includes("mug") || id.includes("keg") || id.includes("bottle") || id.includes("jug")) add("taproom", 1.5);
    if (id.includes("plate") || id.includes("bowl") || id.includes("food") || id.includes("tablecloth")) add("dining_hall", 2);
    if (cat === "clutter_floor" || cat === "furniture_chest") storageContainers++;
    if (cat === "furniture_storage") add("workshop", 1.5);
  }

  if (tables >= 1 && seats >= 2) add("dining_hall", 4 + Math.min(4, seats));
  if (tables >= 1 && cookingGear === 0 && beds === 0 && smithingGear === 0 && (structureCat === "tavern" || structureCat === "inn")) {
    add("taproom", 3);
  }
  if (storageContainers >= 3 && beds === 0 && tables === 0 && cookingGear === 0) add("storage_cellar", 5);
  if (structureCat === "smithy" && smithingGear === 0 && storey === 0) add("smithy_forge", 4);
  if ((structureCat === "chapel" || structureCat === "church") && storey === 0) add("chapel_nave", 4);
  if (structureCat === "stables" && storey === 0) add("stable_bay", 4);
  if ((structureCat === "guardhouse" || structureCat === "barracks" || structureCat === "tower") && storey === 0) {
    add("guard_post", booksOrScrolls > 0 ? 1 : 3);
  }

  let best: RoomType = "living_hall";
  let bestScore = 0;
  for (const [rt, sc] of Object.entries(scores) as Array<[RoomType, number]>) {
    if (sc > bestScore) {
      bestScore = sc;
      best = rt;
    }
  }

  if (bestScore > 0) return best;
  if (totalStoreys > 1 && storey === totalStoreys - 1) return "attic_loft";
  return storey === 0 ? "living_hall" : "bedroom";
}

function addWallEdge(cell: StoreyCell, dir: "N" | "S" | "E" | "W", edge: StoreyWallEdge): void {
  const prev = cell.walls[dir];
  // Door / window cuts take precedence over solid wall when co-located
  if (!prev || prev.kind === "open" || (prev.kind === "wall" && edge.kind !== "wall")) {
    cell.walls[dir] = edge;
  }
}

/** Build Tier 2 StoreySlices, Cells, Room Segmentation (BFS), and Room Graph. */
function buildStoreysAndRooms(
  structureId: string,
  structureCat: StructureCategory,
  parts: InternalPart[],
  cellSize: number,
  floorHeightM: number,
): {
  storeys: StoreySlice[];
  rooms: DecomposedRoom[];
  roomGraph: StructurePrototype["roomGraph"];
  layerCounts: Record<string, number>;
} {
  const levels = detectStoreyElevations(parts, floorHeightM);
  const [originX, originZ] = computeGridOriginXZ(parts, cellSize);

  let maxSpanX = 1;
  let maxSpanZ = 1;
  for (const p of parts) {
    if (!isDressingCategory(p.detailed)) {
      maxSpanX = Math.max(maxSpanX, Math.ceil((p.worldBox.max[0] - originX - 0.15) / cellSize));
      maxSpanZ = Math.max(maxSpanZ, Math.ceil((p.worldBox.max[2] - originZ - 0.15) / cellSize));
    }
  }
  const cols = Math.max(1, maxSpanX);
  const rows = Math.max(1, maxSpanZ);

  const colOf = (x: number) => Math.max(0, Math.min(cols - 1, Math.floor((x - originX) / cellSize)));
  const rowOf = (z: number) => Math.max(0, Math.min(rows - 1, Math.floor((z - originZ) / cellSize)));

  // Assign rough storey first
  for (const p of parts) {
    p.storey = assignStoreyIndex(p, levels, floorHeightM);
  }

  const storeys: StoreySlice[] = [];
  const rooms: DecomposedRoom[] = [];
  const cellToRoom = new Map<string, string>(); // `${level}:${c}:${r}` -> roomId
  const roomMap = new Map<string, DecomposedRoom>();
  const roomGraph: StructurePrototype["roomGraph"] = [];
  const edgeDedup = new Set<string>();

  for (let level = 0; level < levels.length; level++) {
    const elev = levels[level];
    const grid: Array<Array<StoreyCell | null>> = Array.from({ length: rows }, () => Array<StoreyCell | null>(cols).fill(null));
    const ensureCell = (c: number, r: number): StoreyCell | null => {
      if (c < 0 || c >= cols || r < 0 || r >= rows) return null;
      if (!grid[r][c]) grid[r][c] = { c, r, roomId: "", walls: {} };
      return grid[r][c];
    };

    const sParts = parts.filter((p) => p.storey === level);
    const floors = sParts.filter((p) => p.detailed === "floor");

    for (const fl of floors) {
      const cx = (fl.worldBox.min[0] + fl.worldBox.max[0]) / 2;
      const cz = (fl.worldBox.min[2] + fl.worldBox.max[2]) / 2;
      const c = colOf(cx);
      const r = rowOf(cz);
      const cell = ensureCell(c, r);
      if (cell) {
        cell.floorPartId = fl.partId;
        cell.floorAssetRef = fl.assetRef;
      }
    }

    // If a building has walls but no explicit floor meshes at level 0, seed cells inside wall bbox
    if (floors.length === 0) {
      const wParts = sParts.filter((p) => p.detailed === "wall" || p.detailed === "wall_door" || p.detailed === "wall_window");
      if (wParts.length > 0) {
        const wMinC = colOf(Math.min(...wParts.map((w) => (w.worldBox.min[0] + w.worldBox.max[0]) / 2)) + 0.1);
        const wMaxC = colOf(Math.max(...wParts.map((w) => (w.worldBox.min[0] + w.worldBox.max[0]) / 2)) - 0.1);
        const wMinR = rowOf(Math.min(...wParts.map((w) => (w.worldBox.min[2] + w.worldBox.max[2]) / 2)) + 0.1);
        const wMaxR = rowOf(Math.max(...wParts.map((w) => (w.worldBox.min[2] + w.worldBox.max[2]) / 2)) - 0.1);
        for (let r = wMinR; r <= wMaxR; r++) {
          for (let c = wMinC; c <= wMaxC; c++) ensureCell(c, r);
        }
      }
    }

    const openings: RoomOpening[] = [];
    const doorCrossings: Array<{ c1: number; r1: number; c2: number; r2: number; kind: "door" | "arch" | "open" }> = [];

    // Register walls / doors / windows / cuts on cell edges
    const wallLike = sParts.filter(
      (p) => p.detailed === "wall" || p.detailed === "wall_door" || p.detailed === "wall_window" || p.detailed === "wall_cut",
    );
    for (const w of wallLike) {
      const wcx = (w.worldBox.min[0] + w.worldBox.max[0]) / 2;
      const wcz = (w.worldBox.min[2] + w.worldBox.max[2]) / 2;
      const spanX = w.worldBox.size[0];
      const spanZ = w.worldBox.size[2];
      const kind: StoreyWallEdge["kind"] =
        w.detailed === "wall_door" ? "wall_door"
        : w.detailed === "wall_window" ? "wall_window"
        : w.detailed === "wall_cut" ? "wall_cut"
        : "wall";
      const rotDeg = snap90Deg(quatYawDeg(w.rot));
      const edge: StoreyWallEdge = { kind, partId: w.partId, assetRef: w.assetRef, rotDeg };

      if (spanX >= spanZ) {
        // Horizontal East-West wall sitting on a grid row line
        const rLine = Math.round((wcz - originZ) / cellSize);
        const c = colOf(wcx);
        const cellN = grid[rLine - 1]?.[c] ?? null;
        const cellS = grid[rLine]?.[c] ?? null;
        if (cellN) addWallEdge(cellN, "S", edge);
        if (cellS) addWallEdge(cellS, "N", edge);

        // Tag exterior vs interior
        const isExterior = (cellN === null) !== (cellS === null);
        w.layer = isExterior ? "exterior" : "interior";

        if (kind === "wall_door") {
          openings.push({ kind: "door", side: cellN && !cellS ? "S" : "N", localPos: [r3(wcx), r3(elev), r3(wcz)], yawDeg: rotDeg });
          if (cellN && cellS) doorCrossings.push({ c1: c, r1: rLine - 1, c2: c, r2: rLine, kind: "door" });
        } else if (kind === "wall_window") {
          openings.push({ kind: "window", side: cellN && !cellS ? "S" : "N", localPos: [r3(wcx), r3(elev), r3(wcz)], yawDeg: rotDeg });
        } else if (kind === "wall_cut" && cellN && cellS) {
          doorCrossings.push({ c1: c, r1: rLine - 1, c2: c, r2: rLine, kind: "open" });
        }
      } else {
        // Vertical North-South wall sitting on a grid column line
        const cLine = Math.round((wcx - originX) / cellSize);
        const r = rowOf(wcz);
        const cellW = grid[r]?.[cLine - 1] ?? null;
        const cellE = grid[r]?.[cLine] ?? null;
        if (cellW) addWallEdge(cellW, "E", edge);
        if (cellE) addWallEdge(cellE, "W", edge);

        const isExterior = (cellW === null) !== (cellE === null);
        w.layer = isExterior ? "exterior" : "interior";

        if (kind === "wall_door") {
          openings.push({ kind: "door", side: cellW && !cellE ? "E" : "W", localPos: [r3(wcx), r3(elev), r3(wcz)], yawDeg: rotDeg });
          if (cellW && cellE) doorCrossings.push({ c1: cLine - 1, r1: r, c2: cLine, r2: r, kind: "door" });
        } else if (kind === "wall_window") {
          openings.push({ kind: "window", side: cellW && !cellE ? "E" : "W", localPos: [r3(wcx), r3(elev), r3(wcz)], yawDeg: rotDeg });
        } else if (kind === "wall_cut" && cellW && cellE) {
          doorCrossings.push({ c1: cLine - 1, r1: r, c2: cLine, r2: r, kind: "open" });
        }
      }
    }

    for (const st of sParts.filter((p) => (p.detailed === "stairs" || p.detailed === "ladder") && p.worldBox.min[1] >= elev - 0.35)) {
      const scx = (st.worldBox.min[0] + st.worldBox.max[0]) / 2;
      const scz = (st.worldBox.min[2] + st.worldBox.max[2]) / 2;
      openings.push({
        kind: st.detailed === "ladder" ? "ladder" : "stairs",
        localPos: [r3(scx), r3(elev), r3(scz)],
        yawDeg: snap90Deg(quatYawDeg(st.rot)),
        targetStorey: Math.min(levels.length - 1, level + 1),
      });
    }

    // BFS room flood-fill across open internal cell borders
    const visited = new Set<string>();
    const roomCharGrid: string[][] = Array.from({ length: rows }, () => Array<string>(cols).fill(" "));
    let roomSeq = 0;

    const passable = (a: StoreyCell, b: StoreyCell, dirA: "N" | "S" | "E" | "W", dirB: "N" | "S" | "E" | "W"): boolean => {
      const ea = a.walls[dirA]?.kind;
      const eb = b.walls[dirB]?.kind;
      const k = ea ?? eb;
      // Solid partition walls AND interior wall_door partitions delimit discrete rooms (linked later in roomGraph!)
      return k === undefined || k === "open" || k === "wall_cut";
    };

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const start = grid[r][c];
        if (!start || visited.has(`${c},${r}`)) continue;

        const roomId = `${structureId}_s${level}_r${roomSeq}`;
        const label = String.fromCharCode(65 + (roomSeq % 26));
        roomSeq++;
        const queue: Array<[number, number]> = [[c, r]];
        const cells: Array<[number, number]> = [];
        visited.add(`${c},${r}`);

        while (queue.length > 0) {
          const [cc, rr] = queue.shift()!;
          const cur = grid[rr][cc]!;
          cur.roomId = roomId;
          cellToRoom.set(`${level}:${cc}:${rr}`, roomId);
          roomCharGrid[rr][cc] = label;
          cells.push([cc, rr]);

          const nbrs: Array<[number, number, "N" | "S" | "E" | "W", "N" | "S" | "E" | "W"]> = [
            [cc, rr - 1, "N", "S"],
            [cc, rr + 1, "S", "N"],
            [cc + 1, rr, "E", "W"],
            [cc - 1, rr, "W", "E"],
          ];
          for (const [nc, nr, dA, dB] of nbrs) {
            if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
            const nb = grid[nr][nc];
            if (!nb || visited.has(`${nc},${nr}`)) continue;
            if (passable(cur, nb, dA, dB)) {
              visited.add(`${nc},${nr}`);
              queue.push([nc, nr]);
            }
          }
        }

        const rMinX = originX + Math.min(...cells.map(([cx]) => cx)) * cellSize;
        const rMaxX = originX + (Math.max(...cells.map(([cx]) => cx)) + 1) * cellSize;
        const rMinZ = originZ + Math.min(...cells.map(([, rz]) => rz)) * cellSize;
        const rMaxZ = originZ + (Math.max(...cells.map(([, rz]) => rz)) + 1) * cellSize;

        const dr: DecomposedRoom = {
          id: roomId,
          structureId,
          structureCategory: structureCat,
          roomType: "unknown",
          storey: level,
          elevationY: r3(elev),
          bounds: {
            min: [r3(rMinX), r3(elev), r3(rMinZ)],
            max: [r3(rMaxX), r3(elev + floorHeightM), r3(rMaxZ)],
            size: [r3(rMaxX - rMinX), r3(floorHeightM), r3(rMaxZ - rMinZ)],
          },
          cells,
          openings: [],
          parts: [],
          vignetteRefs: [],
          partSummary: {},
        };
        rooms.push(dr);
        roomMap.set(roomId, dr);
      }
    }

    // Connect rooms across interior doorways
    for (const dc of doorCrossings) {
      const rA = cellToRoom.get(`${level}:${dc.c1}:${dc.r1}`);
      const rB = cellToRoom.get(`${level}:${dc.c2}:${dc.r2}`);
      if (rA && rB && rA !== rB) {
        const key = [rA, rB].sort().join("--") + `:${dc.kind}`;
        if (!edgeDedup.has(key)) {
          edgeDedup.add(key);
          roomGraph.push({ fromRoomId: rA, toRoomId: rB, via: dc.kind });
        }
      }
    }

    // Assign parts on this storey to rooms
    const storeyRooms = rooms.filter((rm) => rm.storey === level);
    const sCells: StoreyCell[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r][c]) sCells.push(grid[r][c]!);
      }
    }

    const internalMap = new Map<string, InternalPart[]>();
    for (const rm of storeyRooms) internalMap.set(rm.id, []);

    for (const p of sParts) {
      if (p.detailed === "plinth" || isRoofCategory(p.detailed)) continue;
      if (storeyRooms.length === 0) continue;

      const pcx = (p.worldBox.min[0] + p.worldBox.max[0]) / 2;
      const pcz = (p.worldBox.min[2] + p.worldBox.max[2]) / 2;
      const exactRoomId = cellToRoom.get(`${level}:${colOf(pcx)}:${rowOf(pcz)}`);
      let targetRoomId = exactRoomId;
      if (!targetRoomId) {
        let bestD = Infinity;
        for (const rm of storeyRooms) {
          const rcx = (rm.bounds.min[0] + rm.bounds.max[0]) / 2;
          const rcz = (rm.bounds.min[2] + rm.bounds.max[2]) / 2;
          const d = Math.hypot(pcx - rcx, pcz - rcz);
          if (d < bestD) {
            bestD = d;
            targetRoomId = rm.id;
          }
        }
      }
      if (targetRoomId && internalMap.has(targetRoomId)) {
        p.roomId = targetRoomId;
        internalMap.get(targetRoomId)!.push(p);
      }
    }

    // Classify room types and populate summaries & openings
    for (const rm of storeyRooms) {
      const rInternal = internalMap.get(rm.id) ?? [];
      rm.roomType = classifyRoomType(rInternal, structureCat, level, levels.length);
      for (const ip of rInternal) {
        rm.partSummary[ip.partId] = (rm.partSummary[ip.partId] ?? 0) + 1;
        rm.parts.push({
          partId: ip.partId,
          assetRef: ip.assetRef,
          category: ip.coarse,
          transform: { pos: ip.pos, rot: ip.rot, scale: ip.scale },
          layer: ip.layer,
          storey: level,
          roomId: rm.id,
          groupPath: ip.raw.groupPath,
          bounds: ip.bounds,
        });
      }
      for (const op of openings) {
        const [ox, , oz] = op.localPos;
        if (ox >= rm.bounds.min[0] - 0.6 && ox <= rm.bounds.max[0] + 0.6 && oz >= rm.bounds.min[2] - 0.6 && oz <= rm.bounds.max[2] + 0.6) {
          rm.openings.push(op);
        }
      }
    }

    storeys.push({
      level,
      elevationY: r3(elev),
      floorHeightM,
      cellSizeM: cellSize,
      cols,
      rows,
      originXZ: [originX, originZ],
      plan: roomCharGrid.map((row) => row.join("")),
      cells: sCells,
      openings,
    });
  }

  // Link storeys via stairs / ladders
  for (let level = 0; level < storeys.length - 1; level++) {
    for (const op of storeys[level].openings) {
      if (op.kind !== "stairs" && op.kind !== "ladder") continue;
      const c = colOf(op.localPos[0]);
      const r = rowOf(op.localPos[2]);
      const rLow = cellToRoom.get(`${level}:${c}:${r}`) ?? rooms.find((rm) => rm.storey === level)?.id;
      const rHigh = cellToRoom.get(`${level + 1}:${c}:${r}`) ?? rooms.find((rm) => rm.storey === level + 1)?.id;
      if (rLow && rHigh && rLow !== rHigh) {
        const key = `${rLow}--${rHigh}:${op.kind}`;
        if (!edgeDedup.has(key)) {
          edgeDedup.add(key);
          roomGraph.push({ fromRoomId: rLow, toRoomId: rHigh, via: op.kind });
        }
      }
    }
  }

  const layerCounts: Record<string, number> = {};
  for (const p of parts) {
    layerCounts[p.layer] = (layerCounts[p.layer] ?? 0) + 1;
  }

  return { storeys, rooms, roomGraph, layerCounts };
}

function isVignetteAnchor(cat: DetailedPartCategory, roomParts: PlacedPartInstance[]): boolean {
  if (
    cat === "furniture_table" ||
    cat === "furniture_bar" ||
    cat === "furniture_bed" ||
    cat === "furniture_storage" ||
    cat === "fixture_hearth"
  ) {
    return true;
  }
  if (cat === "furniture_chest") {
    // Only act as standalone anchor if no bed/table is right next to it
    return true;
  }
  return false;
}

function inferVignetteKind(anchorCat: DetailedPartCategory, items: VignetteItem[]): string {
  const cats = new Set(items.map((i) => i.partId.toLowerCase()));
  const joined = [...cats].join(" ");
  if (anchorCat === "furniture_bar") return "bar_service";
  if (anchorCat === "furniture_bed") return "sleeping_alcove";
  if (anchorCat === "fixture_hearth") return joined.includes("anvil") ? "forge_station" : "hearth_station";
  if (anchorCat === "furniture_storage") return joined.includes("book") || anchorCat.includes("book") ? "bookcase_study" : "storage_wall";
  if (anchorCat === "furniture_chest") return "treasure_chest";
  if (joined.includes("map") || joined.includes("wargame")) return "war_table_cluster";
  if (joined.includes("book") || joined.includes("scroll") || joined.includes("ink")) return "study_desk_cluster";
  if (joined.includes("chair") || joined.includes("stool") || joined.includes("bench")) return "dining_table_set";
  return "table_cluster";
}

/** Tier 3: extract reusable DecorationGroupings from each decomposed room. */
function extractRoomVignettes(
  rooms: DecomposedRoom[],
  storeys: StoreySlice[],
  allStructuresParts: Map<string, InternalPart[]>,
): DecorationGrouping[] {
  const bySignature = new Map<string, DecorationGrouping>();
  const roomTypeAcc = new Map<string, Set<RoomType>>();

  for (const room of rooms) {
    const structParts = allStructuresParts.get(room.structureId) ?? [];
    const wallParts = structParts.filter(
      (p) =>
        p.storey === room.storey &&
        (p.detailed === "wall" || p.detailed === "wall_door" || p.detailed === "wall_window"),
    );

    const dressing = room.parts.filter((p) => {
      const d = categorizeDetailedPart(p.partId);
      return isDressingCategory(d);
    });
    if (dressing.length === 0) continue;

    // Prioritize structural anchors (bed, table, bar, storage, hearth) before chests
    const anchors = dressing
      .filter((p) => isVignetteAnchor(categorizeDetailedPart(p.partId), dressing))
      .sort((a, b) => {
        const ca = categorizeDetailedPart(a.partId) === "furniture_chest" ? 1 : 0;
        const cb = categorizeDetailedPart(b.partId) === "furniture_chest" ? 1 : 0;
        return ca - cb;
      });

    const assigned = new Set<number>();
    const anchorIndices = new Map<PlacedPartInstance, number>();
    dressing.forEach((p, idx) => anchorIndices.set(p, idx));

    for (const anchor of anchors) {
      const aIdx = anchorIndices.get(anchor)!;
      if (assigned.has(aIdx)) continue;
      assigned.add(aIdx);

      const aCat = categorizeDetailedPart(anchor.partId);
      const aPos = anchor.transform.pos;
      const aYaw = (quatYawDeg(anchor.transform.rot) * Math.PI) / 180;
      const aMinY = aPos[1] + (anchor.bounds?.min[1] ?? 0);
      const radius = aCat === "furniture_bed" ? 1.85 : aCat === "furniture_bar" ? 2.1 : 1.75;

      const items: VignetteItem[] = [];
      let minX = (anchor.bounds?.min[0] ?? -0.5) * anchor.transform.scale[0];
      let minY = (anchor.bounds?.min[1] ?? 0) * anchor.transform.scale[1];
      let minZ = (anchor.bounds?.min[2] ?? -0.5) * anchor.transform.scale[2];
      let maxX = (anchor.bounds?.max[0] ?? 0.5) * anchor.transform.scale[0];
      let maxY = (anchor.bounds?.max[1] ?? 1.0) * anchor.transform.scale[1];
      let maxZ = (anchor.bounds?.max[2] ?? 0.5) * anchor.transform.scale[2];

      for (let i = 0; i < dressing.length; i++) {
        if (assigned.has(i)) continue;
        const child = dressing[i];
        const cCat = categorizeDetailedPart(child.partId);
        // Never absorb another major anchor unless it's a chest beside a bed/table
        if (isVignetteAnchor(cCat, dressing) && cCat !== "furniture_chest") continue;

        const cPos = child.transform.pos;
        const dx = cPos[0] - aPos[0];
        const dy = cPos[1] - aPos[1];
        const dz = cPos[2] - aPos[2];
        const distXZ = Math.hypot(dx, dz);
        if (distXZ > radius || Math.abs(dy) > 2.0) continue;

        // Classify spatial relation relative to anchor
        let relation: VignetteRelation = "beside";
        let role: VignetteRole = "satellite";
        if (cCat === "decor_rug") {
          relation = "under";
          role = "floor_under";
        } else if (cCat === "decor_wall") {
          relation = "against_wall";
          role = "wall_mount";
        } else if (
          (cCat === "clutter_tabletop" || cCat === "lighting") &&
          cPos[1] >= aMinY + 0.35 &&
          distXZ <= 1.25
        ) {
          relation = "on_top_of";
          role = "tabletop";
        }

        // Convert world delta into anchor-local frame by rotating by -aYaw
        const localOff = rotateVecY([dx, dy, dz], -aYaw);
        const cYawDeg = quatYawDeg(child.transform.rot);
        let relYawDeg = r2(cYawDeg - (aYaw * 180) / Math.PI);
        relYawDeg = ((relYawDeg + 180) % 360 + 360) % 360 - 180;
        const relQuat = mulQuat(yawQuat(-aYaw), child.transform.rot);

        assigned.add(i);
        items.push({
          partId: child.partId,
          assetRef: child.assetRef,
          category: child.category ?? categorizePart(child.partId),
          offset: [r3(localOff[0]), r3(localOff[1]), r3(localOff[2])],
          relativeYawDeg: r2(relYawDeg),
          quat: relQuat,
          scale: child.transform.scale,
          role,
          relation,
          required: cCat === "furniture_seat" || cCat === "decor_rug",
        });

        const cb = child.bounds ?? defaultBoundsFor(cCat);
        minX = Math.min(minX, localOff[0] + cb.min[0] * child.transform.scale[0]);
        minY = Math.min(minY, localOff[1] + cb.min[1] * child.transform.scale[1]);
        minZ = Math.min(minZ, localOff[2] + cb.min[2] * child.transform.scale[2]);
        maxX = Math.max(maxX, localOff[0] + cb.max[0] * child.transform.scale[0]);
        maxY = Math.max(maxY, localOff[1] + cb.max[1] * child.transform.scale[1]);
        maxZ = Math.max(maxZ, localOff[2] + cb.max[2] * child.transform.scale[2]);
      }

      // Check proximity to nearest wall to infer wall-backed vs center vignette preference
      let minWallDist = Infinity;
      for (const wp of wallParts) {
        const wcx = (wp.worldBox.min[0] + wp.worldBox.max[0]) / 2;
        const wcz = (wp.worldBox.min[2] + wp.worldBox.max[2]) / 2;
        const d = Math.hypot(aPos[0] - wcx, aPos[2] - wcz);
        if (d < minWallDist) minWallDist = d;
      }
      const wallBacked =
        minWallDist <= 1.65 ||
        aCat === "furniture_storage" ||
        aCat === "fixture_hearth" ||
        aCat === "furniture_bed" ||
        aCat === "furniture_bar";

      const pref: DecorationGrouping["placementPreference"] =
        aCat === "furniture_storage" || aCat === "fixture_hearth"
          ? "wall_backed"
          : wallBacked && items.some((it) => it.relation === "against_wall")
            ? "wall_backed"
            : items.length >= 2 && aCat === "furniture_table" && !wallBacked
              ? "center"
              : wallBacked
                ? "wall_backed"
                : "any";

      const kind = inferVignetteKind(aCat, items);
      const itemSig = [...items].map((i) => `${i.partId}:${i.role}`).sort().join("|");
      const sig = `${kind}::${anchor.partId}::${itemSig}`;
      const vigId = `vig_${kind}_${anchor.partId}_${bySignature.size + 1}`;

      if (!bySignature.has(sig)) {
        roomTypeAcc.set(sig, new Set([room.roomType]));
        bySignature.set(sig, {
          id: vigId,
          kind,
          roomTypes: [room.roomType],
          anchorPartId: anchor.partId,
          anchorAssetRef: anchor.assetRef,
          anchorCategory: anchor.category ?? categorizePart(anchor.partId),
          footprint: [r3(maxX - minX), r3(maxY - minY), r3(maxZ - minZ)],
          placementPreference: pref,
          facingWall: pref === "wall_backed",
          observedCount: 1,
          items,
        });
      } else {
        const existing = bySignature.get(sig)!;
        existing.observedCount++;
        roomTypeAcc.get(sig)!.add(room.roomType);
        existing.roomTypes = [...roomTypeAcc.get(sig)!];
      }
      const refId = bySignature.get(sig)!.id;
      if (!room.vignetteRefs.includes(refId)) {
        room.vignetteRefs.push(refId);
      }
    }
    void storeys;
  }

  return [...bySignature.values()];
}

/**
 * Decompose normalized `UnityRawNode[]` from one or more Unity scenes/prefabs into
 * a complete 4-tier `DecompositionLibrary` (structures, rooms, vignettes, and learned part rules).
 */
export function decomposeUnityScene(
  rawNodes: readonly UnityRawNode[],
  opts: DecomposeUnityOptions = {},
): DecompositionLibrary {
  const family = opts.family ?? "fantasy-kingdom";
  const source = opts.sourceName ?? "Unity_Scene";
  const license = opts.license ?? "Synty Store EULA";
  const prefix = opts.assetPrefix ?? family;
  const cellSize = opts.cellSizeM ?? 2.5;
  const floorHeightM = opts.floorHeightM ?? 2.5;
  const mergeRadius = opts.mergeInteriorRadiusM ?? 14.0;
  const minParts = opts.minStructureParts ?? 3;

  // 1. Convert raw nodes into annotated InternalParts and bucket by resolved group key
  const namedBuckets = new Map<string, InternalPart[]>();
  const looseDressing: InternalPart[] = [];

  for (const raw of rawNodes) {
    const detailed = categorizeDetailedPart(raw.partId);
    const coarse = categorizePart(raw.partId);
    const catEntry = opts.catalogBounds?.get(raw.partId);
    const bounds = catEntry?.bounds ?? defaultBoundsFor(detailed);
    const assetRef = catEntry?.assetRef ?? `${prefix}/${raw.partId}`;

    const layer: ArchitecturalLayer =
      detailed === "plinth"
        ? "plinth"
        : isRoofCategory(detailed)
          ? "roof"
          : isDressingCategory(detailed) || detailed === "nature"
            ? "dressing"
            : detailed === "floor" || detailed === "ceiling" || detailed === "stairs" || detailed === "ladder"
              ? "interior"
              : "exterior";

    const part: InternalPart = {
      raw,
      partId: raw.partId,
      assetRef,
      detailed,
      coarse,
      bounds,
      pos: [...raw.transform.pos],
      rot: [...raw.transform.rot],
      scale: [...raw.transform.scale],
      worldBox: worldBoundsOfPart(raw.transform.pos, raw.transform.rot, raw.transform.scale, bounds),
      layer,
      storey: 0,
    };

    const { key, isLooseContainer } = resolveStructureGroupKey(raw);
    if (isLooseContainer) {
      if (isDressingCategory(detailed) || raw.isInteriorHint) {
        looseDressing.push(part);
      }
      continue;
    }
    if (!namedBuckets.has(key)) namedBuckets.set(key, []);
    namedBuckets.get(key)!.push(part);
  }

  // Filter valid building buckets (must contain structural walls/floors/roofs)
  const structureBuckets = new Map<string, InternalPart[]>();
  const structAABBs = new Map<string, BoundsData>();
  for (const [key, list] of namedBuckets.entries()) {
    const archCount = list.filter((p) => isStructuralCategory(p.detailed)).length;
    if (archCount < minParts) continue;
    structureBuckets.set(key, list);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of list) {
      if (p.worldBox.min[0] < minX) minX = p.worldBox.min[0];
      if (p.worldBox.min[1] < minY) minY = p.worldBox.min[1];
      if (p.worldBox.min[2] < minZ) minZ = p.worldBox.min[2];
      if (p.worldBox.max[0] > maxX) maxX = p.worldBox.max[0];
      if (p.worldBox.max[1] > maxY) maxY = p.worldBox.max[1];
      if (p.worldBox.max[2] > maxZ) maxZ = p.worldBox.max[2];
    }
    structAABBs.set(key, {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      size: [maxX - minX, maxY - minY, maxZ - minZ],
    });
  }

  // Attach loose sibling Interiors / Props nodes to their enclosing or closest structure
  for (const lp of looseDressing) {
    let bestKey: string | null = null;
    let bestDist = Infinity;
    const lx = lp.pos[0];
    const lz = lp.pos[2];
    const ly = lp.pos[1];
    for (const [key, box] of structAABBs.entries()) {
      if (ly < box.min[1] - 1.5 || ly > box.max[1] + 1.5) continue;
      const dx = lx < box.min[0] ? box.min[0] - lx : lx > box.max[0] ? lx - box.max[0] : 0;
      const dz = lz < box.min[2] ? box.min[2] - lz : lz > box.max[2] ? lz - box.max[2] : 0;
      const dist = Math.hypot(dx, dz);
      if (dist <= mergeRadius && dist < bestDist) {
        bestDist = dist;
        bestKey = key;
      }
    }
    if (bestKey && (bestDist <= 2.5 || lp.raw.isInteriorHint || isDressingCategory(lp.detailed))) {
      structureBuckets.get(bestKey)!.push(lp);
    }
  }

  // 2. Canonicalize each StructurePrototype and build Tier 1 & Tier 2
  const structures: StructurePrototype[] = [];
  const allRooms: DecomposedRoom[] = [];
  const structPartsMap = new Map<string, InternalPart[]>();
  const assemblies: ExampleAssembly[] = [];
  const partBoundsMap = new Map<string, BoundsData>();

  const sortedKeys = [...structureBuckets.keys()].sort();
  for (let idx = 0; idx < sortedKeys.length; idx++) {
    const key = sortedKeys[idx];
    const sParts = structureBuckets.get(key)!;
    const structureId = `struct_${idx + 1}_${key.replace(/[^a-zA-Z0-9_-]+/g, "_")}`;
    const cat = classifyStructureCategory(key, sParts);
    const archetypes = settlementArchetypesFor(cat);
    const { frontYawDeg, footprint, groundY } = canonicalizeStructureParts(sParts);
    const { storeys, rooms, roomGraph, layerCounts } = buildStoreysAndRooms(
      structureId,
      cat,
      sParts,
      cellSize,
      floorHeightM,
    );

    const placedParts: PlacedPartInstance[] = sParts.map((p) => {
      partBoundsMap.set(p.partId, p.bounds);
      partBoundsMap.set(p.assetRef, p.bounds);
      return {
        partId: p.partId,
        assetRef: p.assetRef,
        category: p.coarse,
        transform: { pos: p.pos, rot: p.rot, scale: p.scale },
        layer: p.layer,
        storey: p.storey,
        roomId: p.roomId,
        groupPath: p.raw.groupPath,
        bounds: p.bounds,
      };
    });

    const hasInterior = sParts.some((p) => p.layer === "dressing" || p.raw.isInteriorHint) || rooms.length > 0;
    structures.push({
      id: structureId,
      name: key,
      category: cat,
      settlementArchetypes: archetypes,
      frontYawDeg,
      footprint,
      groundY,
      hasInterior,
      cellSizeM: cellSize,
      storeys,
      rooms,
      roomGraph,
      parts: placedParts,
      layerCounts,
    });
    structPartsMap.set(structureId, sParts);
    allRooms.push(...rooms);

    assemblies.push({
      id: structureId,
      family,
      source,
      license,
      parts: placedParts,
      bounds: {
        min: [r3(-footprint[0] / 2), 0, r3(-footprint[2] / 2)],
        max: [r3(footprint[0] / 2), r3(footprint[1]), r3(footprint[2] / 2)],
        size: footprint,
      },
    });
  }

  // 3. Extract Tier 3 Decoration Groupings (Vignettes) across rooms
  const allStoreys = structures.flatMap((s) => s.storeys);
  const vignettes = extractRoomVignettes(allRooms, allStoreys, structPartsMap);

  // 4. Compute Tier 4 LearnedRuleSet with exact pivot bounds and world-rotated normals
  const ruleSet: LearnedRuleSet = extractLearnedRuleSet(assemblies, {
    family,
    sourceName: source,
    license,
    adjacencyThreshold: 3.5,
    partBounds: partBoundsMap,
  });

  // 5. Compute archetype -> roomType and roomType -> vignetteKind empirical priors + summary stats
  const archetypeRoomPriors: Record<string, Record<string, number>> = {};
  const roomVignettePriors: Record<string, Record<string, number>> = {};
  const roomTypeDist: Record<string, number> = {};
  const vigKindDist: Record<string, number> = {};
  const vigById = new Map(vignettes.map((v) => [v.id, v]));

  for (const s of structures) {
    for (const arch of s.settlementArchetypes) {
      if (!archetypeRoomPriors[arch]) archetypeRoomPriors[arch] = {};
      for (const rm of s.rooms) {
        archetypeRoomPriors[arch][rm.roomType] = (archetypeRoomPriors[arch][rm.roomType] ?? 0) + 1;
      }
    }
  }
  for (const rm of allRooms) {
    roomTypeDist[rm.roomType] = (roomTypeDist[rm.roomType] ?? 0) + 1;
    if (!roomVignettePriors[rm.roomType]) roomVignettePriors[rm.roomType] = {};
    for (const vId of rm.vignetteRefs) {
      const vig = vigById.get(vId);
      if (!vig) continue;
      roomVignettePriors[rm.roomType][vig.kind] = (roomVignettePriors[rm.roomType][vig.kind] ?? 0) + 1;
    }
  }
  for (const v of vignettes) {
    vigKindDist[v.kind] = (vigKindDist[v.kind] ?? 0) + v.observedCount;
  }

  return {
    version: 1,
    family,
    source,
    license,
    extractorVersion: ruleSet.extractorVersion,
    ruleSet,
    structures,
    rooms: allRooms,
    vignettes,
    archetypeRoomPriors,
    roomVignettePriors,
    stats: {
      structures: structures.length,
      structuresWithInteriors: structures.filter((s) => s.hasInterior).length,
      rooms: allRooms.length,
      vignettes: vignettes.length,
      totalParts: ruleSet.stats.totalPlacements,
      categoryDistribution: ruleSet.stats.categoryDistribution,
      roomTypeDistribution: roomTypeDist,
      vignetteKindDistribution: vigKindDist,
    },
  };
}

/** Alias kept for clarity alongside MODEL-SYNTHESIS-MAP terminology. */
export const buildDecompositionLibrary = decomposeUnityScene;
