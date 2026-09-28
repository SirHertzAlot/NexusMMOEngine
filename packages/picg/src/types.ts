/**
 * PICG graph documents as the engine reads and writes them — the subset of
 * PICG's `.pcg` / `.pcgsubgraph` contract (schema/graph-schema-v3.json,
 * subgraph-schema.json upstream) a host needs. Node `data` stays opaque:
 * its properties are defined per node type by PICG's node manifest.
 */

/** A graph node: `type` from the node manifest, or a structural type below. */
export interface PcgNode {
  id: string;
  type: string;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
  /** SubgraphAsset nodes: the linked asset's interface when it was placed. */
  subgraphInterface?: PcgSubgraphInterface;
  [key: string]: unknown;
}

export interface PcgEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  sourcePinType?: string;
  targetPinType?: string;
  [key: string]: unknown;
}

/**
 * A graph parameter: an exposed value written into one node's property
 * before cooking. `targetNode` is a node id, or a path through subgraph
 * instances (`instanceId/nodeId`).
 */
export interface PcgParameter {
  id: string;
  name: string;
  type: "number" | "integer" | "boolean" | "string" | "color" | "vector3" | string;
  default: unknown;
  exposed?: boolean;
  targetNode?: string;
  targetProperty?: string;
  hasRange?: boolean;
  min?: number;
  max?: number;
  description?: string;
  [key: string]: unknown;
}

export interface PcgSubgraphPort {
  id: string;
  name?: string;
  pinType?: string;
}

export interface PcgSubgraphInterface {
  name?: string;
  inputs: PcgSubgraphPort[];
  outputs: PcgSubgraphPort[];
}

/** A subgraph definition embedded in a graph (`graph.subgraphs`). */
export interface PcgSubgraphDefinition {
  id: string;
  name?: string;
  inputs: PcgSubgraphPort[];
  outputs: PcgSubgraphPort[];
  parameters?: PcgParameter[];
  nodes: PcgNode[];
  edges: PcgEdge[];
  [key: string]: unknown;
}

/** A `.pcg` graph. */
export interface PcgGraph {
  version: string;
  name?: string;
  nodes: PcgNode[];
  edges: PcgEdge[];
  parameters?: PcgParameter[];
  subgraphs?: PcgSubgraphDefinition[];
  [key: string]: unknown;
}

/** A `.pcgsubgraph` asset: a reusable part, linked into graphs by GUID. */
export interface PcgSubgraphAsset {
  version: string;
  name?: string;
  inputs: PcgSubgraphPort[];
  outputs: PcgSubgraphPort[];
  parameters?: PcgParameter[];
  nodes: PcgNode[];
  edges: PcgEdge[];
  subgraphs?: PcgSubgraphDefinition[];
  [key: string]: unknown;
}

/** Structural node types (not in the node manifest's executable set). */
export const StructuralNode = {
  /** A linked `.pcgsubgraph` asset, by `data.assetGuid`. */
  SubgraphAsset: "SubgraphAsset",
  /** An instance of an embedded definition, by `data.subgraphId`. */
  Subgraph: "Subgraph",
  SubgraphInput: "SubgraphInput",
  SubgraphOutput: "SubgraphOutput",
} as const;

/** Deep copy (graphs are plain JSON). */
export function cloneGraph<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
