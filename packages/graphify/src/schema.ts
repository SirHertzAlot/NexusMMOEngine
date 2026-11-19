import { createHash } from "node:crypto";
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const CONFIDENCE_VALUES = ["declared", "introspected", "extracted", "inferred"] as const;
export type Confidence = (typeof CONFIDENCE_VALUES)[number];
export const ConfidenceSchema = z.enum(CONFIDENCE_VALUES);

export const SYSTEM_ROLE_VALUES = ["simulation", "infrastructure", "authoring"] as const;
export type SystemRole = (typeof SYSTEM_ROLE_VALUES)[number];
export const SystemRoleSchema = z.enum(SYSTEM_ROLE_VALUES);

export const NODE_KIND_VALUES = [
  "component",
  "field",
  "system",
  "module",
  "object",
  "archetype",
  "verb",
  "widget",
] as const;
export type NodeKind = (typeof NODE_KIND_VALUES)[number];
export const NodeKindSchema = z.enum(NODE_KIND_VALUES);

export const EDGE_KIND_VALUES = [
  "hasComponent",
  "fieldOf",
  "reads",
  "writes",
  "excludes",
  "instantiates",
  "realizes",
  "contributedBy",
  "touches",
  "summons",
  "operatesOn",
] as const;
export type EdgeKind = (typeof EDGE_KIND_VALUES)[number];
export const EdgeKindSchema = z.enum(EDGE_KIND_VALUES);

export const FieldSummarySchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  arrayLength: z.number().int().positive().optional(),
});
export type FieldSummary = z.infer<typeof FieldSummarySchema>;

export const GraphNodeSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().regex(/^component:[A-Za-z0-9_]+$/),
    kind: z.literal("component"),
    name: z.string().min(1),
    source: z.string().min(1),
    componentId: z.number().int().nonnegative().optional(),
    sab: z.boolean(),
    tag: z.boolean(),
    addable: z.boolean().optional(),
    fields: z.array(FieldSummarySchema),
  }),
  z.object({
    id: z.string().regex(/^field:[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/),
    kind: z.literal("field"),
    name: z.string().min(1),
    component: z.string().min(1),
    fieldType: z.string().min(1),
    sab: z.boolean(),
    arrayLength: z.number().int().positive().optional(),
    protocolRows: z.array(z.string()).optional(),
    source: z.string().min(1),
  }),
  z.object({
    id: z.string().regex(/^system:[A-Za-z0-9_-]+$/),
    kind: z.literal("system"),
    name: z.string().min(1),
    simName: z.string().min(1).optional(),
    className: z.string().min(1).optional(),
    role: SystemRoleSchema,
    module: z.string().min(1).optional(),
    tickIndex: z.number().int().nonnegative().optional(),
    declared: z.boolean(),
    inRoster: z.boolean().optional(),
    source: z.string().min(1),
  }),
  z.object({
    id: z.string().regex(/^module:[A-Za-z0-9_-]+$/),
    kind: z.literal("module"),
    name: z.string().min(1),
    version: z.string().optional(),
    description: z.string().optional(),
    entry: z.string().optional(),
    systems: z.array(z.string()),
    source: z.string().min(1),
  }),
  z.object({
    id: z.string().regex(/^object:.+\/.+$/),
    kind: z.literal("object"),
    name: z.string().min(1),
    scene: z.string().min(1),
    sceneKind: z.string().optional(),
    nodeKind: z.string().optional(),
    archetype: z.string().regex(/^archetype:[a-f0-9]+$/).optional(),
    source: z.string().min(1),
  }),
  z.object({
    id: z.string().regex(/^archetype:[a-f0-9]+$/),
    kind: z.literal("archetype"),
    name: z.string().min(1),
    components: z.array(z.string()),
    objectCount: z.number().int().nonnegative(),
    source: z.string().min(1),
  }),
  z.object({
    id: z.string().regex(/^verb:[^\s]+$/),
    kind: z.literal("verb"),
    name: z.string().min(1),
    aliases: z.array(z.string()).optional(),
    home: z.string().optional(),
    signature: z.string().optional(),
    source: z.string().min(1),
  }),
  z.object({
    id: z.string().regex(/^widget:[^\s]+$/),
    kind: z.literal("widget"),
    name: z.string().min(1),
    components: z.array(z.string()).optional(),
    verbs: z.array(z.string()).optional(),
    source: z.string().min(1),
  }),
]);
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: EdgeKindSchema,
  confidence: ConfidenceSchema,
  source: z.string().min(1),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/** Regular expression asserting POSIX-normalized `path:line` format. */
export const FILE_LINE_RE = /^[^:\n]+:\d+$/;

export const UnresolvedSiteSchema = z.object({
  system: z.string().optional(),
  site: z.string().regex(FILE_LINE_RE, "unresolved.site must be formatted as file:line"),
  reason: z.string().min(1),
  expression: z.string().optional(),
});
export type UnresolvedSite = z.infer<typeof UnresolvedSiteSchema>;

export const CoverageEntrySchema = z.object({
  source: z.string().min(1),
  status: z.enum(["extracted", "partial", "summary-only"]),
  count: z.number().int().nonnegative(),
  details: z.string().min(1),
});
export type CoverageEntry = z.infer<typeof CoverageEntrySchema>;

export const GraphCountsSchema = z.object({
  nodes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  byNodeKind: z.record(NodeKindSchema, z.number().int().nonnegative()),
  byEdgeKind: z.record(EdgeKindSchema, z.number().int().nonnegative()),
  unresolved: z.number().int().nonnegative(),
  declaredSystems: z.number().int().nonnegative(),
  simulationSystems: z.number().int().nonnegative(),
});
export type GraphCounts = z.infer<typeof GraphCountsSchema>;

export const GraphMetaSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  builtFromCommit: z.string().min(1),
  graphHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHashes: z.record(z.string(), z.string()),
  counts: GraphCountsSchema,
  coverage: z.array(CoverageEntrySchema),
  unresolved: z.array(UnresolvedSiteSchema),
});
export type GraphMeta = z.infer<typeof GraphMetaSchema>;

export const EcsGraphSchema = z.object({
  meta: GraphMetaSchema,
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});
export type EcsGraph = z.infer<typeof EcsGraphSchema>;

/** Normalize any filesystem path to POSIX forward slashes for cross-OS determinism. */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Compute a deterministic content-addressed archetype identifier from a component set.
 * Pure over the deduplicated sorted component names.
 */
export function archetypeId(components: readonly string[]): string {
  const canonical = [...new Set(components)].sort();
  const digest = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  return `archetype:${digest.slice(0, 12)}`;
}

/** Recursively sort object keys so JSON serialization is deterministic regardless of insertion order. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const val = record[key];
      if (val !== undefined) {
        sorted[key] = sortKeysDeep(val);
      }
    }
    return sorted;
  }
  return value;
}

/** Deterministic canonical JSON stringification (sorted keys, 2-space indent, trailing newline). */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/** Compute SHA-256 digest over canonicalized nodes and edges arrays. */
export function computeGraphHash(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
  return createHash("sha256")
    .update(canonicalJson({ nodes, edges }), "utf8")
    .digest("hex");
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  declared: 0,
  introspected: 1,
  extracted: 2,
  inferred: 3,
};

/**
 * Canonicalize node/edge/metadata ordering, compute counts and `graphHash`,
 * and return a deterministic `EcsGraph`.
 */
export function finalizeGraph(input: {
  builtFromCommit: string;
  sourceHashes: Record<string, string>;
  coverage: CoverageEntry[];
  unresolved: UnresolvedSite[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}): EcsGraph {
  const nodeMap = new Map<string, GraphNode>();
  for (const rawNode of input.nodes) {
    const node = sortNodeArrays(rawNode);
    nodeMap.set(node.id, node);
  }
  const nodes = [...nodeMap.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Deduplicate edges by (from, to, kind), keeping the highest-confidence edge (and sorted source on tie).
  const edgeBest = new Map<string, GraphEdge>();
  for (const edge of input.edges) {
    const key = `${edge.from}\u0000${edge.kind}\u0000${edge.to}`;
    const existing = edgeBest.get(key);
    if (!existing) {
      edgeBest.set(key, edge);
      continue;
    }
    const rankDiff = CONFIDENCE_RANK[edge.confidence] - CONFIDENCE_RANK[existing.confidence];
    if (rankDiff < 0 || (rankDiff === 0 && edge.source < existing.source)) {
      edgeBest.set(key, edge);
    }
  }
  const edges = [...edgeBest.values()].sort((a, b) => {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.to !== b.to) return a.to < b.to ? -1 : 1;
    return 0;
  });

  const sortedHashes: Record<string, string> = {};
  for (const key of Object.keys(input.sourceHashes).sort()) {
    sortedHashes[toPosixPath(key)] = input.sourceHashes[key];
  }

  const unresolved = [...input.unresolved]
    .map((u) => ({ ...u, site: toPosixPath(u.site) }))
    .sort((a, b) => {
      if (a.site !== b.site) return a.site < b.site ? -1 : 1;
      const sa = a.system ?? "";
      const sb = b.system ?? "";
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
    });

  const coverage = [...input.coverage].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
  );

  const byNodeKind: Record<NodeKind, number> = {
    component: 0,
    field: 0,
    system: 0,
    module: 0,
    object: 0,
    archetype: 0,
    verb: 0,
    widget: 0,
  };
  let declaredSystems = 0;
  let simulationSystems = 0;
  for (const n of nodes) {
    byNodeKind[n.kind]++;
    if (n.kind === "system") {
      if (n.declared) declaredSystems++;
      if (n.role === "simulation") simulationSystems++;
    }
  }

  const byEdgeKind: Record<EdgeKind, number> = {
    hasComponent: 0,
    fieldOf: 0,
    reads: 0,
    writes: 0,
    excludes: 0,
    instantiates: 0,
    realizes: 0,
    contributedBy: 0,
    touches: 0,
    summons: 0,
    operatesOn: 0,
  };
  for (const e of edges) {
    byEdgeKind[e.kind]++;
  }

  const graphHash = computeGraphHash(nodes, edges);

  return {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      builtFromCommit: input.builtFromCommit,
      graphHash,
      sourceHashes: sortedHashes,
      counts: {
        nodes: nodes.length,
        edges: edges.length,
        byNodeKind,
        byEdgeKind,
        unresolved: unresolved.length,
        declaredSystems,
        simulationSystems,
      },
      coverage,
      unresolved,
    },
    nodes,
    edges,
  };
}

function sortNodeArrays(node: GraphNode): GraphNode {
  switch (node.kind) {
    case "component":
      return {
        ...node,
        fields: [...node.fields].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      };
    case "field":
      return node.protocolRows
        ? { ...node, protocolRows: [...new Set(node.protocolRows)].sort() }
        : node;
    case "module":
      return { ...node, systems: [...node.systems] };
    case "archetype":
      return { ...node, components: [...new Set(node.components)].sort() };
    case "verb":
      return node.aliases ? { ...node, aliases: [...new Set(node.aliases)].sort() } : node;
    case "widget":
      return {
        ...node,
        ...(node.components ? { components: [...new Set(node.components)].sort() } : {}),
        ...(node.verbs ? { verbs: [...new Set(node.verbs)].sort() } : {}),
      };
    default:
      return node;
  }
}
