/**
 * An authoring graph made cookable: linked subgraph assets inlined (the
 * hierarchy), parameter values written into their target nodes (paths
 * reach into the inlined parts), and edge pin-type annotations dropped.
 *
 * The annotations are authoring metadata: pcg-core re-derives every pin
 * type from its node manifest, and after it flattens a subgraph an
 * annotation written against the subgraph's port (e.g. `SpatialMesh`)
 * would be checked against whatever pin now sits there (an `Any` input),
 * failing a valid graph.
 */

import { applyParameters, type ParameterValues } from "./parameters.js";
import { hasLinkedSubgraphs, resolveLinkedSubgraphs, type SubgraphLoader } from "./resolve.js";
import { cloneGraph, type PcgEdge, type PcgGraph } from "./types.js";

export interface PrepareOptions {
  /** Loads linked `.pcgsubgraph` assets by GUID (required if the graph links any). */
  loadSubgraph?: SubgraphLoader;
  /** Parameter values by id or name; the rest keep their defaults. */
  parameters?: ParameterValues;
}

export interface PreparedGraph {
  graph: PcgGraph;
  /** Linked subgraph GUIDs the result depends on. */
  dependencies: string[];
}

function stripPinTypes(edges: PcgEdge[]): PcgEdge[] {
  return edges.map(({ sourcePinType: _s, targetPinType: _t, ...edge }) => edge as PcgEdge);
}

export function prepareForCook(graph: PcgGraph, opts: PrepareOptions = {}): PreparedGraph {
  let working = cloneGraph(graph);
  let dependencies: string[] = [];
  if (hasLinkedSubgraphs(working)) {
    if (!opts.loadSubgraph) throw new Error("graph links subgraph assets but no loader was given");
    ({ graph: working, dependencies } = resolveLinkedSubgraphs(working, opts.loadSubgraph));
  }
  working = applyParameters(working, opts.parameters);
  working.edges = stripPinTypes(working.edges);
  for (const def of working.subgraphs ?? []) def.edges = stripPinTypes(def.edges);
  if (working.version === "3.0") working.version = "2.0";
  return { graph: working, dependencies };
}
