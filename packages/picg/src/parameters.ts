/**
 * Graph parameters: a graph's exposed knobs, each written into one node's
 * property before cooking (PICG's PcgParameterApplicator contract).
 *
 * A parameter's `targetNode` is a node id in the graph, or a path through
 * subgraph instances (`crown/deform`: node `deform` inside the definition
 * instance `crown` uses). PICG's own hosts write into the shared
 * definition, so every instance of it changes; here a path write gives
 * that instance a private copy first, so one tree's crown can be tuned
 * without reshaping every other tree that shares the part.
 */

import { cloneGraph, StructuralNode, type PcgGraph, type PcgNode, type PcgParameter, type PcgSubgraphDefinition } from "./types.js";

/** Parameter values by parameter id or name. */
export type ParameterValues = Record<string, unknown>;

/** The graph's exposed parameters (all of them when none is marked). */
export function exposedParameters(graph: PcgGraph): PcgParameter[] {
  const all = graph.parameters ?? [];
  return all.some((p) => p.exposed !== undefined) ? all.filter((p) => p.exposed !== false) : all;
}

/** A value checked against its parameter: numbers clamped to the range, integers rounded. */
export function coerceParameter(param: PcgParameter, value: unknown): unknown {
  switch (param.type) {
    case "number":
    case "integer": {
      let n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) throw new Error(`parameter ${param.name}: ${JSON.stringify(value)} is not a number`);
      if (param.type === "integer") n = Math.round(n);
      if (param.hasRange && typeof param.min === "number" && typeof param.max === "number") {
        n = Math.min(param.max, Math.max(param.min, n));
      }
      return n;
    }
    case "boolean":
      return value === true || value === "true" || value === 1;
    case "string":
    case "color":
      return String(value);
    default:
      return cloneGraph(value);
  }
}

/**
 * The graph with parameter values applied (defaults for the rest):
 * each written into its target node's property.
 */
export function applyParameters(graph: PcgGraph, values: ParameterValues = {}): PcgGraph {
  const out = cloneGraph(graph);
  for (const param of out.parameters ?? []) {
    if (!param.targetNode || !param.targetProperty) continue;
    const given = param.id in values ? values[param.id] : param.name in values ? values[param.name] : undefined;
    const value = coerceParameter(param, given === undefined ? param.default : given);
    const node = findTargetNode(out, param.targetNode, true);
    if (!node) throw new Error(`parameter ${param.name}: target node '${param.targetNode}' not found`);
    node.data = { ...(node.data ?? {}), [param.targetProperty]: value };
  }
  return out;
}

/** The current value of every parameter (defaults unless overridden). */
export function parameterValues(graph: PcgGraph, values: ParameterValues = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of graph.parameters ?? []) {
    const given = p.id in values ? values[p.id] : p.name in values ? values[p.name] : undefined;
    out[p.id] = coerceParameter(p, given === undefined ? p.default : given);
  }
  return out;
}

/**
 * The node a parameter targets. A bare id is looked up in the root, then
 * (uniquely) in embedded definitions; a path walks subgraph instances. With
 * `forWrite`, a path's definitions are copied per instance on the way down.
 */
export function findTargetNode(graph: PcgGraph, target: string, forWrite = false): PcgNode | null {
  if (!target.includes("/")) {
    const root = graph.nodes.find((n) => n.id === target);
    if (root) return root;
    let found: PcgNode | null = null;
    for (const def of graph.subgraphs ?? []) {
      const n = def.nodes.find((x) => x.id === target);
      if (!n) continue;
      if (found) return null; // ambiguous
      found = n;
    }
    return found;
  }
  const parts = target.split("/").filter(Boolean);
  graph.subgraphs ??= [];
  let nodes = graph.nodes;
  let scopeId = "";
  for (let i = 0; i < parts.length; i++) {
    const node = nodes.find((n) => n.id === parts[i]);
    if (!node) return null;
    if (i === parts.length - 1) return node;
    if (node.type !== StructuralNode.Subgraph) return null;
    const defId = String(node.data?.subgraphId ?? "");
    let def = graph.subgraphs.find((d) => d.id === defId);
    if (!def) return null;
    if (forWrite) {
      // A private copy for this instance (once): writes stay local to it.
      scopeId = scopeId ? `${scopeId}.${node.id}` : node.id;
      const privateId = `${defId}@${scopeId}`;
      let own = graph.subgraphs.find((d) => d.id === privateId);
      if (!own) {
        own = { ...cloneGraph(def), id: privateId } as PcgSubgraphDefinition;
        graph.subgraphs.push(own);
      }
      node.data = { ...(node.data ?? {}), subgraphId: privateId };
      def = own;
    }
    nodes = def.nodes;
  }
  return null;
}
