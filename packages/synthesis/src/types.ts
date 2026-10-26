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

export interface SynthesisProblem {
  ruleSet: LearnedRuleSet;
  seed: number;
  site: SynthesisSite;
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
}

export class SynthesisError extends Error {
  constructor(message: string, readonly report?: Partial<SynthesisReport>) {
    super(message);
    this.name = "SynthesisError";
  }
}
