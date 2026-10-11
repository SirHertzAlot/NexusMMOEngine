/**
 * Edge module registry + latency-probe discovery (roadmap EA12).
 *
 * Edge modules are declared in module manifests:
 *
 *   { "name": "voice-us-east", "version": "1.0.0",
 *     "edge": { "regions": ["us-east"],
 *               "endpoint": "wss://voice-us-east.example.com",
 *               "capabilities": ["voice", "video"] } }
 *
 * They run on edge nodes — regional voice servers, CDN edges, matchmaking
 * lobbies — work that must be near players but never on the authoritative
 * simulation. This file is registration/discovery only: the edge never
 * simulates, and nothing here touches the tick.
 *
 *   EdgeRegistry         in-memory registry of edge module declarations
 *   loadEdgeModules      discover + enabled-set -> registry (server boot)
 *   discoverNearestEdge  latency-probe candidates, return the fastest
 *   edgeModulesHandler   express handler for GET /api/edge/modules
 */

import { performance } from "node:perf_hooks";
import type { Request, Response } from "express";
import {
  discoverModules,
  readEnabledSet,
  type DiscoveredModule,
  type Problem,
} from "@mmo-engine/modules";

export interface EdgeModuleInfo {
  module: string;
  version: string;
  regions: string[];
  endpoint: string;
  capabilities: string[];
}

export interface EdgeFilter {
  region?: string;
  capability?: string;
}

/** In-memory registry of edge module declarations. Re-registering a module name replaces it. */
export class EdgeRegistry {
  private readonly byModule = new Map<string, EdgeModuleInfo>();

  registerEdgeModule(info: EdgeModuleInfo): void {
    this.byModule.set(info.module, {
      module: info.module,
      version: info.version,
      regions: [...info.regions],
      endpoint: info.endpoint,
      capabilities: [...info.capabilities],
    });
  }

  unregisterEdgeModule(module: string): boolean {
    return this.byModule.delete(module);
  }

  clear(): void {
    this.byModule.clear();
  }

  get size(): number {
    return this.byModule.size;
  }

  /** List registered edges, optionally filtered by region and/or capability. Insertion order. */
  listEdges(filter: EdgeFilter = {}): EdgeModuleInfo[] {
    const out: EdgeModuleInfo[] = [];
    for (const info of this.byModule.values()) {
      if (filter.region !== undefined && !info.regions.includes(filter.region)) continue;
      if (filter.capability !== undefined && !info.capabilities.includes(filter.capability)) continue;
      out.push(info);
    }
    return out;
  }
}

const edgeInfo = (m: DiscoveredModule): EdgeModuleInfo | undefined => {
  const e = m.manifest.edge;
  if (!e) return undefined;
  return { module: m.manifest.name, version: m.manifest.version, regions: e.regions, endpoint: e.endpoint, capabilities: e.capabilities };
};

/**
 * Build a registry from the module system: discover `<modulesDir>`, keep the
 * enabled set from `setFile` (content/modules.json), register every enabled
 * module that declares an `edge` contribution. Problems (bad manifests,
 * unknown enabled names) are returned, never thrown.
 */
export function loadEdgeModules(
  modulesDir: string,
  setFile: string,
): { registry: EdgeRegistry; problems: Problem[] } {
  const registry = new EdgeRegistry();
  const found = discoverModules(modulesDir);
  const set = readEnabledSet(setFile);
  const enabled = new Set(set.modules);
  const problems: Problem[] = [...found.problems, ...set.problems];
  for (const m of found.valid) {
    if (!enabled.has(m.manifest.name)) continue;
    const info = edgeInfo(m);
    if (info) registry.registerEdgeModule(info);
  }
  return { registry, problems };
}

/** Map a module endpoint to a probeable HTTP(S) URL (ws:// -> http://, wss:// -> https://). */
export function probeUrl(endpoint: string): string {
  return endpoint.replace(/^(ws)(s)?:\/\//i, (_m, _w, s) => (s ? "https://" : "http://"));
}

export type ProbeFn = (url: string, timeoutMs: number) => Promise<number>;

/**
 * Default probe: HTTP GET the endpoint, returning the round-trip time in ms.
 * Any HTTP response (even 4xx/5xx) counts — we measure network latency, not
 * application health. Network errors and timeouts resolve to Infinity so the
 * candidate is skipped by discovery.
 */
export async function probeEndpoint(url: string, timeoutMs = 2000): Promise<number> {
  const target = probeUrl(url);
  const started = performance.now();
  try {
    await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    return performance.now() - started;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export interface DiscoverOptions {
  timeoutMs?: number;
  /** Injectable probe for tests: resolves latency ms, or Infinity when unreachable. */
  probe?: ProbeFn;
}

/**
 * Pick the lowest-latency reachable candidate. All candidates are probed
 * concurrently; unreachable ones (Infinity) are skipped. Returns undefined
 * when nothing is reachable. Ties keep input order (stable).
 */
export async function discoverNearestEdge(
  candidates: EdgeModuleInfo[],
  opts: DiscoverOptions = {},
): Promise<EdgeModuleInfo | undefined> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const probe = opts.probe ?? probeEndpoint;
  const latencies = await Promise.all(candidates.map((c) => probe(c.endpoint, timeoutMs)));
  let best: EdgeModuleInfo | undefined;
  let bestMs = Number.POSITIVE_INFINITY;
  candidates.forEach((c, i) => {
    const ms = latencies[i];
    if (ms < bestMs) {
      bestMs = ms;
      best = c;
    }
  });
  return best;
}

/** Express handler for `GET /api/edge/modules[?region=&capability=]`. Pure over the registry: easy to unit test. */
export function edgeModulesHandler(registry: EdgeRegistry) {
  return (req: Request, res: Response): void => {
    const region = typeof req.query.region === "string" && req.query.region.length > 0 ? req.query.region : undefined;
    const capability =
      typeof req.query.capability === "string" && req.query.capability.length > 0 ? req.query.capability : undefined;
    res.json({ ok: true, modules: registry.listEdges({ region, capability }) });
  };
}
