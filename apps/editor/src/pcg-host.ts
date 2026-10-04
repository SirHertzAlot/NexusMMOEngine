/**
 * PICG asset library for the editor dev host (ROADMAP E6).
 *
 * The browser cannot read `content/pcg`, so the dev host serves the
 * library over a loopback-only route (wired in host.ts):
 *
 *   GET /api/editor/pcg/library → every asset of `content/pcg/index.json`
 *       with its AssetRef hash, variants, and the graph's exposed
 *       parameters (each with its default and this asset's value)
 *
 *   GET /api/editor/pcg/docs        → every editable document: the assets'
 *       graphs (.pcg) and the linked parts (.pcgsubgraph), by file (E7)
 *   GET /api/editor/pcg/doc?file=…  → one document's JSON
 *   PUT /api/editor/pcg/doc         → {file, doc}: validate, then write back
 *       pretty-printed (2 spaces); 422 with issues when refused
 *
 * Only files the index names are read or written, and every path is
 * confined to <repo>/content/pcg (normalized containment check), so an
 * index entry can't reach outside it. A save is checked the way the
 * server's cook reads it: node and edge structure, then every library
 * graph that uses the document is resolved (linked parts inlined) and has
 * its parameters applied (prepareForCook), so a part edit that breaks a
 * tree's parameter target, or a pin interface a graph links, is refused.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  exposedParameters,
  fnv1a32,
  parameterValues,
  canonicalGuid,
  parseLibraryIndex,
  prepareForCook,
  StructuralNode,
  type PcgGraph,
  type PcgLibraryAsset,
  type PcgLibraryIndex,
  type PcgSubgraphAsset,
} from "@mmo-engine/picg";

/** One graph parameter as a selection card shows it. */
export interface PcgParameterView {
  id: string;
  name: string;
  type: string;
  /** The graph's default. */
  default: unknown;
  /** The value this asset cooks with (its override, else the default). */
  value: unknown;
  /** The asset overrides the default. */
  overridden: boolean;
  min?: number;
  max?: number;
  description?: string;
}

/** One library asset: what an entity's AssetRef points at. */
export interface PcgAssetView {
  id: string;
  /** AssetRef.assetHash: fnv1a32(id). */
  assetHash: number;
  displayName: string;
  /** The `.pcg`, relative to content/pcg. */
  graph: string;
  variants: number;
  description?: string;
  parameters: PcgParameterView[];
  /** Why the graph couldn't be read (the asset is still listed). */
  error?: string;
}

export interface PcgLibraryView {
  assets: PcgAssetView[];
  subgraphs: Array<{ guid: string; file: string; name?: string }>;
}

/** <repo>/content/pcg — the only directory library reads touch. */
export function pcgDir(repoRoot: string): string {
  return resolve(repoRoot, "content", "pcg");
}

/** Absolute path of a library file; throws { status: 403 } if it escapes content/pcg. */
export function resolvePcgPath(repoRoot: string, file: string): string {
  const dir = pcgDir(repoRoot);
  const path = resolve(dir, file);
  if (!path.startsWith(dir + sep)) {
    throw Object.assign(new Error(`path escapes content/pcg: ${file}`), { status: 403 });
  }
  return path;
}

/** An asset's parameters: exposed ones, with defaults and the asset's own values. */
export function assetParameters(graph: PcgGraph, asset: PcgLibraryAsset): PcgParameterView[] {
  const overrides = asset.parameters ?? {};
  const values = parameterValues(graph, overrides);
  return exposedParameters(graph).map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    default: p.default,
    value: values[p.id],
    overridden: p.id in overrides || p.name in overrides,
    ...(p.hasRange && typeof p.min === "number" ? { min: p.min } : {}),
    ...(p.hasRange && typeof p.max === "number" ? { max: p.max } : {}),
    ...(typeof p.description === "string" ? { description: p.description } : {}),
  }));
}

/** The library as the selection cards read it. */
export function readPcgLibrary(repoRoot: string): PcgLibraryView {
  const indexPath = resolvePcgPath(repoRoot, "index.json");
  if (!existsSync(indexPath)) return { assets: [], subgraphs: [] };
  const index = parseLibraryIndex(JSON.parse(readFileSync(indexPath, "utf8")) as unknown);
  const assets = index.assets.map((asset): PcgAssetView => {
    const base = {
      id: asset.id,
      assetHash: fnv1a32(asset.id),
      displayName: asset.displayName ?? asset.id,
      graph: asset.graph,
      variants: Math.max(1, Math.floor(asset.variants ?? 1)),
    };
    try {
      const graph = JSON.parse(readFileSync(resolvePcgPath(repoRoot, asset.graph), "utf8")) as PcgGraph;
      const description = typeof graph.description === "string" ? graph.description : undefined;
      return { ...base, ...(description ? { description } : {}), parameters: assetParameters(graph, asset) };
    } catch (err) {
      return { ...base, parameters: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
  return { assets, subgraphs: index.subgraphs };
}

// ---- documents (E7) -------------------------------------------------------

/** An editable library document. */
export interface PcgDocumentInfo {
  /** Path relative to content/pcg. */
  file: string;
  kind: "graph" | "subgraph";
  name: string;
  /** Graphs: the asset ids that cook it. Subgraphs: the GUID graphs link. */
  assets?: string[];
  guid?: string;
}

export interface PcgIssue {
  /** Where: a node, edge or parameter id, or a dependent graph's file. */
  path: string;
  message: string;
}

function readIndex(repoRoot: string): PcgLibraryIndex {
  return parseLibraryIndex(JSON.parse(readFileSync(resolvePcgPath(repoRoot, "index.json"), "utf8")) as unknown);
}

/** Every document the index names, graphs first. */
export function listPcgDocuments(repoRoot: string): PcgDocumentInfo[] {
  if (!existsSync(resolvePcgPath(repoRoot, "index.json"))) return [];
  const index = readIndex(repoRoot);
  const graphs = new Map<string, PcgDocumentInfo>();
  for (const a of index.assets) {
    const doc = graphs.get(a.graph) ?? { file: a.graph, kind: "graph" as const, name: a.displayName ?? a.id, assets: [] };
    doc.assets!.push(a.id);
    graphs.set(a.graph, doc);
  }
  const parts = index.subgraphs.map((sg): PcgDocumentInfo => ({ file: sg.file, kind: "subgraph", name: sg.name ?? sg.file, guid: canonicalGuid(sg.guid) }));
  return [...graphs.values(), ...parts];
}

/** Throws { status: 404 } unless `file` is a document the index names. */
function documentInfo(repoRoot: string, file: string): PcgDocumentInfo {
  const info = listPcgDocuments(repoRoot).find((d) => d.file === file);
  if (!info) throw Object.assign(new Error(`not a PICG library document: ${file}`), { status: 404 });
  return info;
}

export function readPcgDocument(repoRoot: string, file: string): { info: PcgDocumentInfo; doc: unknown } {
  const info = documentInfo(repoRoot, file);
  return { info, doc: JSON.parse(readFileSync(resolvePcgPath(repoRoot, file), "utf8")) as unknown };
}

/** Node and edge structure of one graph level (the root or an embedded definition). */
function structureIssues(level: { nodes?: unknown; edges?: unknown }, where: string, issues: PcgIssue[]): void {
  if (!Array.isArray(level.nodes)) {
    issues.push({ path: where, message: "nodes must be an array" });
    return;
  }
  if (!Array.isArray(level.edges)) issues.push({ path: where, message: "edges must be an array" });
  const ids = new Set<string>();
  for (const n of level.nodes as Array<Record<string, unknown>>) {
    if (!n || typeof n.id !== "string" || !n.id) {
      issues.push({ path: where, message: "every node needs a string id" });
      continue;
    }
    if (ids.has(n.id)) issues.push({ path: `${where}${n.id}`, message: `duplicate node id '${n.id}'` });
    ids.add(n.id);
    if (typeof n.type !== "string" || !n.type) issues.push({ path: `${where}${n.id}`, message: "node needs a type" });
    if (n.data !== undefined && (typeof n.data !== "object" || n.data === null || Array.isArray(n.data))) {
      issues.push({ path: `${where}${n.id}`, message: "node data must be an object" });
    }
    if (n.type === StructuralNode.SubgraphAsset && typeof (n.data as Record<string, unknown> | undefined)?.assetGuid !== "string") {
      issues.push({ path: `${where}${n.id}`, message: "a SubgraphAsset node needs data.assetGuid" });
    }
  }
  for (const e of (Array.isArray(level.edges) ? level.edges : []) as Array<Record<string, unknown>>) {
    const id = typeof e?.id === "string" ? e.id : "edge";
    if (typeof e?.source !== "string" || !ids.has(e.source)) issues.push({ path: `${where}${id}`, message: `edge source '${String(e?.source)}' is not a node` });
    if (typeof e?.target !== "string" || !ids.has(e.target)) issues.push({ path: `${where}${id}`, message: `edge target '${String(e?.target)}' is not a node` });
  }
}

/**
 * Everything wrong with `doc` as `file`, against the rest of the library:
 * structure, then a cook-preparation of every graph it affects.
 */
export function validatePcgDocument(repoRoot: string, file: string, doc: unknown): PcgIssue[] {
  const info = documentInfo(repoRoot, file);
  const issues: PcgIssue[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [{ path: file, message: "document must be a JSON object" }];
  const d = doc as Record<string, unknown>;
  if (typeof d.version !== "string") issues.push({ path: "version", message: "version must be a string" });
  structureIssues(d, "", issues);
  for (const def of (Array.isArray(d.subgraphs) ? d.subgraphs : []) as Array<Record<string, unknown>>) {
    structureIssues(def, `${String(def?.id ?? "subgraph")}/`, issues);
  }
  if (info.kind === "subgraph" && (!Array.isArray(d.inputs) || !Array.isArray(d.outputs))) {
    issues.push({ path: file, message: "a subgraph needs inputs and outputs arrays" });
  }
  if (issues.length) return issues;

  // Cook preparation of every graph this document reaches, with the candidate in place.
  const index = readIndex(repoRoot);
  const loader = (guid: string): PcgSubgraphAsset | string | null => {
    const entry = index.subgraphs.find((sg) => canonicalGuid(sg.guid) === canonicalGuid(guid));
    if (!entry) return null;
    if (entry.file === file) return doc as PcgSubgraphAsset;
    return readFileSync(resolvePcgPath(repoRoot, entry.file), "utf8");
  };
  for (const asset of index.assets) {
    if (info.kind === "graph" && asset.graph !== file) continue;
    let graph: PcgGraph;
    try {
      graph = asset.graph === file ? (doc as PcgGraph) : (JSON.parse(readFileSync(resolvePcgPath(repoRoot, asset.graph), "utf8")) as PcgGraph);
      prepareForCook(graph, { loadSubgraph: loader, parameters: asset.parameters });
    } catch (err) {
      issues.push({ path: `${asset.graph} (${asset.id})`, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return issues;
}

/** Validate, then write pretty-printed. Throws { status: 422, issues } when refused. */
export function savePcgDocument(repoRoot: string, file: string, doc: unknown): void {
  const issues = validatePcgDocument(repoRoot, file, doc);
  if (issues.length) {
    throw Object.assign(new Error(`${file}: ${issues.length} issue(s); not saved`), { status: 422, issues });
  }
  writeFileSync(resolvePcgPath(repoRoot, file), JSON.stringify(doc, null, 2) + "\n");
}
