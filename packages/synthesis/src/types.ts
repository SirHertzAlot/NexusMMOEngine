/**
 * Data contracts and Zod schemas for continuous model synthesis,
 * scene decomposition, and learned adjacency rules.
 *
 * Implements specifications from MODEL-SYNTHESIS-MAP.md §7.
 */

import { z } from "zod";

export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

export interface TransformData {
  pos: Vec3Tuple;
  rot: QuatTuple;
  scale: Vec3Tuple;
}

export interface BoundsData {
  min: Vec3Tuple;
  max: Vec3Tuple;
  size: Vec3Tuple;
}

export type ArchitecturalLayer = "plinth" | "exterior" | "interior" | "roof" | "dressing";

export interface PlacedPartInstance {
  partId: string;
  assetRef: string;
  category?: string;
  transform: TransformData;
  instanceId?: string;
  layer?: ArchitecturalLayer;
  storey?: number;
  roomId?: string;
  groupPath?: string;
  bounds?: BoundsData;
}

export interface AnchorPoint {
  name: string;
  pos: Vec3Tuple;
  dir?: Vec3Tuple;
}

export interface ExampleAssembly {
  id: string;
  family: string;
  source: string;
  license: string;
  parts: PlacedPartInstance[];
  anchors?: AnchorPoint[];
  bounds?: BoundsData;
}

export interface SocketDef {
  name: string;
  kind: string; // e.g. "wall-edge", "floor-edge", "pillar-cap", "ceiling-socket", "prop-mount"
  offset: Vec3Tuple; // local offset from part pivot
  normal: Vec3Tuple; // outward normal vector
}

export interface PartDef {
  id: string;
  assetRef: string;
  category: string;
  bounds: BoundsData;
  sockets: SocketDef[];
}

export interface AdjacencyRule {
  aPart: string;
  aSocket: string;
  bPart: string;
  bSocket: string;
  count: number;
  frequency: number;
  transformStats: {
    meanOffset: Vec3Tuple;
    spreadOffset: Vec3Tuple;
    relativeYawDeg: number;
  };
}

export interface LearnedRuleSet {
  family: string;
  extractorVersion: string;
  sourceAssemblies: string[];
  parts: Record<string, PartDef>;
  adjacency: AdjacencyRule[];
  terminals: Array<{ partId: string; socket: string }>;
  stats: {
    totalPlacements: number;
    uniqueParts: number;
    totalAdjacencyPairs: number;
    categoryDistribution: Record<string, number>;
    partFrequencies: Record<string, number>;
  };
}

export interface SynthesisSite {
  bounds: {
    min: Vec3Tuple;
    max: Vec3Tuple;
  };
  groundHeight?: (x: number, z: number) => number;
  conditionFields?: Record<string, number>;
}

export interface SynthesisBudget {
  maxParts: number;
  maxGrowthAttempts?: number;
  timeBudgetMs?: number;
}

export interface PuzzleInputSlot {
  slotIndex: number;
  kind: "rune-pillar" | "dial" | "lever";
  partId: string;
  options: string[]; // Limited set of available states/symbols (e.g. ["Rune_01", "Rune_02", "Rune_04", "Rune_05"])
  currentState: string;
  transform: TransformData;
}

export interface PuzzleCluePlacement {
  clueIndex: number;
  partId: string;
  symbol: string; // The correct answer plainly shown before the entrypoint
  clueType: "banner" | "statue" | "book" | "carving" | "inscription";
  description: string;
  transform: TransformData;
  roomLocation: string;
}

export interface CombinationPuzzleDefinition {
  puzzleId: string;
  name: string;
  target: {
    type: "door" | "chest";
    partId: string;
    targetRef: string;
    transform: TransformData;
    isLocked: boolean;
  };
  entrypoint: {
    inputs: PuzzleInputSlot[];
    promptTransform: TransformData;
  };
  solution: string[]; // Ordered sequence required to unlock
  clues: PuzzleCluePlacement[]; // Plainly shown clues placed through earlier dungeon areas
  possibleCombinationsCount: number; // Discrete bounded combinations space (e.g. 4^3 = 64)
  onUnlock: {
    action: "open_door" | "unlock_chest";
    animation: string;
    grantsAccessTo: string;
  };
}

export interface CollisionTrapDefinition {
  trapId: string;
  trapType: "floor-spear-grate" | "swinging-blade" | "saw-rail" | "pit-hatch" | "grinder";
  partId: string;
  assetRef: string;
  transform: TransformData;
  triggerVolume: {
    shape: "box" | "cylinder";
    boundsMin: Vec3Tuple;
    boundsMax: Vec3Tuple;
    hidden: boolean; // Hidden spot flush with floor
  };
  onCollision: {
    animation: string;
    damage: number;
    damageType: "physical" | "bleed" | "crush";
    cooldownSec: number;
    knockbackVec?: Vec3Tuple;
  };
  state: "armed" | "triggered" | "cooldown" | "disarmed";
}

export interface RoomBlueprint {
  archetype?: "crypt-hall" | "boss-arena" | "multi-level-descent" | "corridor" | "vault" | "chamber";
  widthM?: number;
  lengthM?: number;
  wallHeightM?: number;
  colonnadeSpacingM?: number;
  elevationDropM?: number;
  entranceDoor?: boolean;
  focalPiece?: "sarcophagus" | "altar" | "throne" | "none";
  traps?: {
    enabled?: boolean;
    floorSpikes?: boolean;
    sawRails?: boolean;
    swingingBlades?: boolean;
  };
  puzzles?: {
    enabled?: boolean;
    levers?: boolean;
    statueDials?: boolean;
    combinationPillars?: boolean;
  };
}

export interface SynthesisProblem {
  ruleSet: LearnedRuleSet;
  seed: number;
  site: SynthesisSite;
  blueprint?: RoomBlueprint;
  pins?: Array<{ partId: string; transform: TransformData }>;
  budget: SynthesisBudget;
}

export interface SynthesizedPlacement {
  partId: string;
  assetRef: string;
  category: string;
  transform: TransformData;
  /** The part's extent in metres, along its own axes before yaw: its native bounds times its scale. */
  size: Vec3Tuple;
  /** Native pivot-relative bounds (before yaw/scale) when available from GLB/catalog. */
  pivotBounds?: BoundsData;
  /** Semantic layer within a building or interior assembly. */
  layer?: ArchitecturalLayer;
  /** Room identifier this placement belongs to (when synthesized inside a room). */
  roomId?: string;
  /** Storey index (0 = ground floor, 1+ = upper floors). */
  storey?: number;
  /** Optional scene interaction metadata (e.g. door leaf, shop counter vendor, loot chest). */
  interaction?: {
    kind: "door" | "vendor" | "chest";
    template?: string;
    table?: string;
  };
  /** Optional collider hint ("none" for roofs/clutter/rugs, "split-doorway", "stairs", "floor", "solid"). */
  colliderMode?: "none" | "solid" | "floor" | "split-doorway" | "stairs";
}

export interface SynthesisReport {
  partsPlaced: number;
  growthAttempts: number;
  unfilledSockets: number;
  elapsedMs: number;
  ruleSetVersion: string;
  categoryCounts: Record<string, number>;
}

export interface SynthesisMeasurementReport {
  spatialPerception: {
    tier: "claustrophobic" | "intimate" | "expansive" | "monumental" | "abyssal";
    eyeClearanceM: number;
    widthToHeightRatio: number;
    apparentVolumeM3: number;
    immersionDescription: string;
  };
  scaleTierCounts: Record<string, number>;
  humanScaleBaseline: {
    referenceHeightM: number;
    eyeLevelM: number;
    stepOverThresholdM: number;
    reachRadiusM: number;
  };
  interactivitySummary: {
    interactableCount: number;
    traversalObstacleCount: number;
    stepOverCount: number;
  };
}

export interface SynthesisOutput {
  placements: SynthesizedPlacement[];
  report: SynthesisReport;
  puzzles?: CombinationPuzzleDefinition[];
  traps?: CollisionTrapDefinition[];
  measurement?: SynthesisMeasurementReport;
}

export class SynthesisError extends Error {
  constructor(message: string, readonly report?: Partial<SynthesisReport>) {
    super(message);
    this.name = "SynthesisError";
  }
}

// ---------------------------------------------------------------------------
// 4-Tier Hierarchical Decomposition & Building WFC/Synthesis Contracts
// Tier 1: Structure archetypes -> Tier 2: Room types ->
// Tier 3: Decoration groupings (vignettes) -> Tier 4: Modular parts & rules
// ---------------------------------------------------------------------------

export type StructureCategory =
  | "house"
  | "townhouse"
  | "tavern"
  | "inn"
  | "smithy"
  | "workshop"
  | "bakery"
  | "shop"
  | "chapel"
  | "church"
  | "mill"
  | "windmill"
  | "granary"
  | "stables"
  | "tower"
  | "guardhouse"
  | "barracks"
  | "hut"
  | "shelter"
  | "outhouse"
  | "warehouse"
  | "library"
  | "castle"
  | "unknown";

export type RoomType =
  | "taproom"
  | "dining_hall"
  | "bedroom"
  | "kitchen_hearth"
  | "study_library"
  | "smithy_forge"
  | "chapel_nave"
  | "storage_cellar"
  | "war_room"
  | "stable_bay"
  | "attic_loft"
  | "living_hall"
  | "guard_post"
  | "workshop"
  | "entryway"
  | "corridor"
  | "unknown";

export type VignetteRelation = "center" | "beside" | "on_top_of" | "under" | "against_wall";
export type VignetteRole = "anchor" | "satellite" | "tabletop" | "wall_mount" | "floor_under";

export interface VignetteItem {
  partId: string;
  assetRef: string;
  category: string;
  /** Offset relative to anchor origin in anchor-local coordinates (metres). */
  offset: Vec3Tuple;
  /** Yaw delta relative to anchor yaw (degrees). */
  relativeYawDeg: number;
  /** Relative local quaternion from anchor to child. */
  quat: QuatTuple;
  scale: Vec3Tuple;
  role: VignetteRole;
  relation: VignetteRelation;
  required: boolean;
}

export interface DecorationGrouping {
  id: string;
  kind: string;
  roomTypes: RoomType[];
  anchorPartId: string;
  anchorAssetRef: string;
  anchorCategory: string;
  footprint: Vec3Tuple;
  placementPreference: "center" | "wall_backed" | "corner" | "any";
  facingWall: boolean;
  observedCount: number;
  items: VignetteItem[];
}

export interface RoomOpening {
  kind: "door" | "arch" | "window" | "stairs" | "ladder";
  side?: "N" | "S" | "E" | "W";
  localPos: Vec3Tuple;
  yawDeg: number;
  targetRoomId?: string;
  targetStorey?: number;
}

export interface DecomposedRoom {
  id: string;
  structureId: string;
  structureCategory: StructureCategory;
  roomType: RoomType;
  storey: number;
  elevationY: number;
  bounds: BoundsData;
  cells: Array<[number, number]>;
  openings: RoomOpening[];
  parts: PlacedPartInstance[];
  vignetteRefs: string[];
  partSummary: Record<string, number>;
}

export interface StoreyWallEdge {
  kind: "wall" | "wall_door" | "wall_window" | "wall_cut" | "open" | "partition";
  partId?: string;
  assetRef?: string;
  rotDeg?: number;
}

export interface StoreyCell {
  c: number;
  r: number;
  floorPartId?: string;
  floorAssetRef?: string;
  roomId: string;
  walls: Partial<Record<"N" | "S" | "E" | "W", StoreyWallEdge>>;
}

export interface StoreySlice {
  level: number;
  elevationY: number;
  floorHeightM: number;
  cellSizeM: number;
  cols: number;
  rows: number;
  originXZ: [number, number];
  plan: string[];
  cells: StoreyCell[];
  openings: RoomOpening[];
}

export interface StructurePrototype {
  id: string;
  name: string;
  category: StructureCategory;
  settlementArchetypes: string[];
  /** Front-facing yaw in original normalized space (degrees). */
  frontYawDeg: number;
  footprint: Vec3Tuple;
  groundY: number;
  hasInterior: boolean;
  cellSizeM: number;
  storeys: StoreySlice[];
  rooms: DecomposedRoom[];
  roomGraph: Array<{ fromRoomId: string; toRoomId: string; via: "door" | "arch" | "stairs" | "ladder" | "open" }>;
  parts: PlacedPartInstance[];
  layerCounts: Record<string, number>;
}

export interface DecompositionLibrary {
  version: 1;
  family: string;
  source: string;
  license: string;
  extractorVersion: string;
  ruleSet: LearnedRuleSet;
  structures: StructurePrototype[];
  rooms: DecomposedRoom[];
  vignettes: DecorationGrouping[];
  archetypeRoomPriors: Record<string, Record<string, number>>;
  roomVignettePriors: Record<string, Record<string, number>>;
  stats: {
    structures: number;
    structuresWithInteriors: number;
    rooms: number;
    vignettes: number;
    totalParts: number;
    categoryDistribution: Record<string, number>;
    roomTypeDistribution: Record<string, number>;
    vignetteKindDistribution: Record<string, number>;
  };
}

export interface BuildingSynthesisOptions {
  archetype: string;
  seed: number;
  /** Available plot footprint [widthX, depthZ] in metres (building fits cleanly inside). */
  maxFootprintM?: [number, number];
  /** Target interior furnishing density in [0, 1] (default 0.75). */
  dressingDensity?: number;
  /** Optional room-type overrides per storey / room index. */
  pinRooms?: RoomType[];
  /** Target world facing yaw in degrees (0 = +Z front). Default 0. */
  frontYawDeg?: number;
  /** Whether to re-synthesize interior decoration vignettes using WFC + Learned rules instead of verbatim replay. Default true. */
  synthesizeInteriors?: boolean;
}

export interface BuildingRoomPlan {
  roomId: string;
  roomType: RoomType;
  storey: number;
  elevationY: number;
  bounds: BoundsData;
  vignettesPlaced: string[];
}

export interface BuildingSynthesisResult {
  archetype: string;
  prototypeId: string;
  structureCategory: StructureCategory;
  footprint: Vec3Tuple;
  groundY: number;
  rooms: BuildingRoomPlan[];
  placements: SynthesizedPlacement[];
  report: SynthesisReport & {
    roomsPlanned: number;
    vignettesPlaced: number;
    wfcRestarts: number;
  };
}
