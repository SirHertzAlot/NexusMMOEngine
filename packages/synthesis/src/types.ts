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

export interface PlacedPartInstance {
  partId: string;
  assetRef: string;
  category?: string;
  transform: TransformData;
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
}

export interface SynthesisReport {
  partsPlaced: number;
  growthAttempts: number;
  unfilledSockets: number;
  elapsedMs: number;
  ruleSetVersion: string;
  categoryCounts: Record<string, number>;
}

export interface SynthesisOutput {
  placements: SynthesizedPlacement[];
  report: SynthesisReport;
  puzzles?: CombinationPuzzleDefinition[];
  traps?: CollisionTrapDefinition[];
}

export class SynthesisError extends Error {
  constructor(message: string, readonly report?: Partial<SynthesisReport>) {
    super(message);
    this.name = "SynthesisError";
  }
}
