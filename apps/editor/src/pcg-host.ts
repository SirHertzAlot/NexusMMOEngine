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
 * Read-only. Only files the index names are read, and every path is
 * confined to <repo>/content/pcg (normalized containment check), so an
 * index entry can't reach outside it.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  exposedParameters,
  fnv1a32,
  parameterValues,
  parseLibraryIndex,
  type PcgGraph,
  type PcgLibraryAsset,
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
