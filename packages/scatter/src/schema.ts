/**
 * `.pcg.json` authoring format — Zod schemas.
 *
 * A graph is the source of truth (UE PCG shape): nodes with typed
 * settings, edges carrying point lists, graph-level parameters, and
 * instances (graph + parameter overrides, the Material-Instance
 * equivalent). The cooker (src/cooker.ts) validates structure here and
 * validates settings against the node registry (src/nodes.ts).
 *
 * A setting value may be a literal or a parameter reference
 * `{ "$param": "name" }`, resolved at cook time.
 */
import { z } from "zod";

/** `{ "$param": "name" }` — resolved against graph params / instance overrides. */
export const ParamRefSchema = z.object({ $param: z.string().min(1) });
export type ParamRef = z.infer<typeof ParamRefSchema>;

export function isParamRef(v: unknown): v is ParamRef {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).$param === "string" &&
    ((v as Record<string, unknown>).$param as string).length > 0
  );
}

export const PcNodeSchema = z.object({
  id: z.string().min(1, "node id must be non-empty"),
  type: z.string().min(1, "node type must be non-empty"),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type PcNode = z.infer<typeof PcNodeSchema>;

export const PcEdgeSchema = z.object({
  from: z.string().min(1, "edge 'from' must name a node id"),
  to: z.string().min(1, "edge 'to' must name a node id"),
});
export type PcEdge = z.infer<typeof PcEdgeSchema>;

export const PcParamSchema = z.object({
  name: z.string().min(1, "param name must be non-empty"),
  type: z.enum(["number", "string", "boolean"]),
  default: z.union([z.number(), z.string(), z.boolean()]),
  description: z.string().optional(),
});
export type PcParam = z.infer<typeof PcParamSchema>;

export const PcGraphSchema = z.object({
  name: z.string().min(1, "graph name must be non-empty"),
  version: z.literal(1, "unsupported .pcg.json version"),
  nodes: z.array(PcNodeSchema).min(1, "graph must have at least one node"),
  edges: z.array(PcEdgeSchema).default([]),
  params: z.array(PcParamSchema).default([]),
});
export type PcGraph = z.infer<typeof PcGraphSchema>;

export const PcInstanceSchema = z.object({
  /** Graph name this instance overrides (resolved by the caller). */
  graph: z.string().min(1, "instance must name a graph"),
  params: z
    .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
    .default({}),
});
export type PcInstance = z.infer<typeof PcInstanceSchema>;

/** Parse + structurally validate a `.pcg.json` document. Throws on invalid. */
export function parseGraphJSON(json: unknown): PcGraph {
  return PcGraphSchema.parse(json);
}

/** Parse + structurally validate a `.pcg-instance.json` document. */
export function parseInstanceJSON(json: unknown): PcInstance {
  return PcInstanceSchema.parse(json);
}
