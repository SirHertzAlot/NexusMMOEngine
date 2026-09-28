/**
 * Linked-subgraph resolution: the hierarchy.
 *
 * A PICG graph can link reusable `.pcgsubgraph` assets by GUID
 * (`SubgraphAsset` nodes, graph v3), and those assets can link others.
 * pcg-core only executes self-contained documents, so a host inlines every
 * linked asset as an embedded definition (`graph.subgraphs`) and turns each
 * `SubgraphAsset` node into a `Subgraph` instance of it; pcg-core then
 * flattens the embedded definitions itself.
 *
 * Port of PICG's Unity host (PcgExternalSubgraphResolver.cs, same limits,
 * errors, and definition ids — `__ext_` + the first 16 hex of
 * sha256(guid)), so a graph resolves identically in Unity and the engine.
 */

import { sha256Hex } from "./sha256.js";
import {
  cloneGraph,
  StructuralNode,
  type PcgEdge,
  type PcgGraph,
  type PcgNode,
  type PcgSubgraphAsset,
  type PcgSubgraphDefinition,
  type PcgSubgraphInterface,
  type PcgSubgraphPort,
} from "./types.js";

export const MAX_SUBGRAPH_DEPTH = 32;
export const MAX_SUBGRAPH_ASSETS = 256;

/** Loads a linked `.pcgsubgraph` by GUID: the asset (object or JSON text), or null when unknown. */
export type SubgraphLoader = (guid: string) => PcgSubgraphAsset | string | null;

export class SubgraphResolveError extends Error {
  constructor(message: string, readonly chain: string) {
    super(`${message} (at ${chain})`);
    this.name = "SubgraphResolveError";
  }
}

export interface ResolvedGraph {
  /** Self-contained graph: no SubgraphAsset nodes left. */
  graph: PcgGraph;
  /** Every linked asset GUID it depends on, sorted. */
  dependencies: string[];
}

/** Lower-cased 32-hex GUIDs lose their hyphens; other ids are kept as written. */
export function canonicalGuid(guid: string): string {
  const trimmed = guid.trim();
  const plain = trimmed.replace(/-/g, "");
  return /^[0-9a-fA-F]{32}$/.test(plain) ? plain.toLowerCase() : trimmed;
}

function validGuid(guid: string): boolean {
  return guid.length > 0 && guid.length <= 256 && !/\s/.test(guid);
}

/** The embedded definition id a linked asset resolves to. */
export function definitionIdForGuid(guid: string): string {
  const canonical = canonicalGuid(guid);
  if (!validGuid(canonical)) throw new Error("assetGuid is empty or invalid.");
  return "__ext_" + sha256Hex(canonical).slice(0, 16);
}

interface ResolvedAsset {
  guid: string;
  definitionId: string;
  asset: PcgSubgraphAsset;
  interface: PcgSubgraphInterface;
  nested: PcgSubgraphDefinition[];
}

/** True if any node in the graph (or its embedded definitions) links an asset. */
export function hasLinkedSubgraphs(graph: PcgGraph): boolean {
  const scan = (nodes: PcgNode[] | undefined): boolean =>
    (nodes ?? []).some((n) => n.type === StructuralNode.SubgraphAsset);
  return scan(graph.nodes) || (graph.subgraphs ?? []).some((d) => scan(d.nodes));
}

/** Inline every linked subgraph asset (recursively) into `graph.subgraphs`. */
export function resolveLinkedSubgraphs(graph: PcgGraph, load: SubgraphLoader): ResolvedGraph {
  const working = cloneGraph(graph);
  working.subgraphs ??= [];
  const memo = new Map<string, ResolvedAsset>();
  const idToGuid = new Map<string, string>();
  const stack: string[] = [];
  const dependencies: string[] = [];

  const chainOf = (instancePath: string, nodeId: string): string =>
    (stack.length > 0 ? stack.join(" -> ") + " | " : "") + `${instancePath}/${nodeId}`;

  const ensureDefinition = (resolved: ResolvedAsset): void => {
    const defs = working.subgraphs!;
    if (!defs.some((d) => d.id === resolved.definitionId)) {
      const a = resolved.asset;
      const root: PcgSubgraphDefinition = {
        id: resolved.definitionId,
        name: a.name ?? "",
        inputs: a.inputs.map(clonePort),
        outputs: a.outputs.map(clonePort),
        parameters: cloneGraph(a.parameters ?? []),
        nodes: cloneGraph(a.nodes),
        edges: cloneGraph(a.edges),
      };
      remapInlineSubgraphIds(root.nodes, resolved.definitionId);
      defs.push(root);
    }
    for (const nested of resolved.nested) {
      if (!defs.some((d) => d.id === nested.id)) defs.push(cloneGraph(nested));
    }
  };

  const resolveScope = (
    nodes: PcgNode[],
    edges: PcgEdge[],
    localDefinitions: PcgSubgraphDefinition[] | null,
    depth: number,
    instancePath: string,
  ): void => {
    // Snapshot: resolving may append to the same (root) list.
    for (const definition of [...(localDefinitions ?? [])]) {
      resolveScope(definition.nodes, definition.edges, null, depth, `${instancePath}/${definition.id}`);
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.type !== StructuralNode.SubgraphAsset) continue;
      if (depth >= MAX_SUBGRAPH_DEPTH) {
        throw new SubgraphResolveError(`External subgraph depth exceeded ${MAX_SUBGRAPH_DEPTH}.`, chainOf(instancePath, node.id));
      }
      const guid = canonicalGuid(String(node.data?.assetGuid ?? ""));
      if (!validGuid(guid)) {
        throw new SubgraphResolveError(`Invalid SubgraphAsset.assetGuid on node '${node.id}'.`, chainOf(instancePath, node.id));
      }
      if (stack.includes(guid)) {
        throw new SubgraphResolveError(`Recursive external subgraph reference detected: ${guid}`, `${chainOf(instancePath, node.id)} -> ${guid}`);
      }
      let resolved = memo.get(guid);
      if (!resolved) {
        if (memo.size >= MAX_SUBGRAPH_ASSETS) {
          throw new SubgraphResolveError(`External subgraph asset count exceeded ${MAX_SUBGRAPH_ASSETS}.`, chainOf(instancePath, node.id));
        }
        const source = load(guid);
        if (source === null) {
          throw new SubgraphResolveError(`Missing or unreadable SubgraphAsset '${guid}'.`, chainOf(instancePath, node.id));
        }
        let asset: PcgSubgraphAsset;
        try {
          asset = typeof source === "string" ? (JSON.parse(source) as PcgSubgraphAsset) : cloneGraph(source);
        } catch (err) {
          throw new SubgraphResolveError(`Failed to parse SubgraphAsset '${guid}': ${(err as Error).message}`, chainOf(instancePath, node.id));
        }
        asset.inputs ??= [];
        asset.outputs ??= [];
        asset.nodes ??= [];
        asset.edges ??= [];
        asset.subgraphs ??= [];
        const definitionId = definitionIdForGuid(guid);
        const owner = idToGuid.get(definitionId);
        if (owner !== undefined && owner !== guid) {
          throw new SubgraphResolveError(`External subgraph definition id collision between '${owner}' and '${guid}'.`, chainOf(instancePath, node.id));
        }
        idToGuid.set(definitionId, guid);
        resolved = {
          guid,
          definitionId,
          asset,
          interface: { name: asset.name ?? "", inputs: asset.inputs.map(clonePort), outputs: asset.outputs.map(clonePort) },
          nested: [],
        };
        memo.set(guid, resolved);
        dependencies.push(guid);

        stack.push(guid);
        resolveScope(asset.nodes, asset.edges, asset.subgraphs, depth + 1, `${instancePath}/${node.id}`);
        stack.pop();

        for (const nested of asset.subgraphs) {
          const remapped = cloneGraph(nested);
          remapped.id = `${definitionId}__${nested.id}`;
          remapInlineSubgraphIds(remapped.nodes, definitionId);
          resolved.nested.push(remapped);
        }
      }

      const mismatch = interfaceMismatch(node.subgraphInterface, resolved.interface, edges, node.id);
      if (mismatch) {
        throw new SubgraphResolveError(`SubgraphAsset interface mismatch on '${node.id}': ${mismatch}`, chainOf(instancePath, node.id));
      }
      nodes[i] = {
        id: node.id,
        type: StructuralNode.Subgraph,
        ...(node.position ? { position: node.position } : {}),
        data: { ...cloneGraph(node.data ?? {}), subgraphId: resolved.definitionId },
      };
      ensureDefinition(resolved);
    }
  };

  resolveScope(working.nodes, working.edges, working.subgraphs, 0, "<root>");
  if (hasLinkedSubgraphs(working)) {
    throw new SubgraphResolveError("Resolve left residual SubgraphAsset nodes.", "<root>");
  }
  if (working.version === "3.0") working.version = "2.0";
  return { graph: working, dependencies: [...new Set(dependencies)].sort() };
}

function clonePort(port: PcgSubgraphPort): PcgSubgraphPort {
  return { id: port.id, ...(port.name !== undefined ? { name: port.name } : {}), ...(port.pinType !== undefined ? { pinType: port.pinType } : {}) };
}

/** Instances of an asset's own embedded definitions move under its definition id. */
function remapInlineSubgraphIds(nodes: PcgNode[], assetDefinitionId: string): void {
  for (const node of nodes) {
    if (node.type !== StructuralNode.Subgraph) continue;
    const local = String(node.data?.subgraphId ?? "");
    if (!local || local.startsWith("__ext_")) continue;
    node.data = { ...node.data, subgraphId: `${assetDefinitionId}__${local}` };
  }
}

/**
 * The placed node's remembered interface against the asset's current one:
 * a removed or retyped port is an error only if an edge still uses it.
 */
function interfaceMismatch(
  snapshot: PcgSubgraphInterface | undefined,
  source: PcgSubgraphInterface,
  edges: PcgEdge[],
  nodeId: string,
): string | null {
  if (!snapshot) return "missing persisted snapshot";
  for (const input of [true, false]) {
    const direction = input ? "input" : "output";
    const sourceById = new Map<string, PcgSubgraphPort>();
    for (const port of input ? source.inputs : source.outputs) {
      if (!port.id) return `${direction} port id is empty in source`;
      if (sourceById.has(port.id)) return `duplicate source ${direction} port id '${port.id}'`;
      sourceById.set(port.id, port);
    }
    for (const port of (input ? snapshot.inputs : snapshot.outputs) ?? []) {
      if (!port.id) return `${direction} snapshot port id is empty`;
      const connected = edges.some((e) =>
        input ? e.target === nodeId && e.targetHandle === port.id : e.source === nodeId && e.sourceHandle === port.id,
      );
      const current = sourceById.get(port.id);
      if (!current) {
        if (connected) return `source removed ${direction} port '${port.id}'`;
        continue;
      }
      if ((port.pinType ?? "Any") !== (current.pinType ?? "Any") && connected) {
        return `${direction} port '${port.id}' pinType changed (${port.pinType} -> ${current.pinType})`;
      }
    }
  }
  return null;
}
