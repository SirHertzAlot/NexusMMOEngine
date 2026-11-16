/**
 * Graphify artifact host route (`/api/editor/graph`, GRAPHIFY-HARVESTER-SPEC.md §8 & §9 H4).
 *
 * Serves `content/graph/ecs-graph.json` from the editor dev host (loopback only),
 * caches the parsed artifact by `(mtimeMs, size)`, compares `meta.builtFromCommit`
 * against the repository HEAD so stale graphs are surfaced visibly, and trims bulk
 * scene `object:` nodes by default unless `?object=<id>` or `?full=1` is asked.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RouteReply } from "./api.js";
import type { EcsGraphEdge, EcsGraphNode, EcsGraphPayload } from "./ecs-graph-model.js";

const GRAPH_REL = join("content", "graph", "ecs-graph.json");

interface CachedGraph {
  mtimeMs: number;
  size: number;
  data: EcsGraphPayload;
  /** Schema/system/module/archetype/verb/widget subgraph (omits 7k+ scene object nodes). */
  coreNodes: EcsGraphNode[];
  coreEdges: EcsGraphEdge[];
  objectsById: Map<string, EcsGraphNode>;
  instantiatesByObjectId: Map<string, EcsGraphEdge[]>;
}

const cacheByRoot = new Map<string, CachedGraph>();

/** Lightweight `.git/HEAD` reader matching `engine-core/src/admin/live-overlay.ts`. */
export function resolveRepoHead(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const headPath = join(dir, ".git", "HEAD");
    if (existsSync(headPath)) {
      try {
        const raw = readFileSync(headPath, "utf8").trim();
        if (raw.startsWith("ref:")) {
          const refRel = raw.slice(4).trim();
          const refPath = join(dir, ".git", ...refRel.split("/"));
          if (existsSync(refPath)) return readFileSync(refPath, "utf8").trim() || null;
          const packed = join(dir, ".git", "packed-refs");
          if (existsSync(packed)) {
            for (const line of readFileSync(packed, "utf8").split(/\r?\n/)) {
              if (!line || line.startsWith("#") || line.startsWith("^")) continue;
              const [sha, name] = line.split(" ");
              if (name === refRel && sha) return sha.trim();
            }
          }
          return null;
        }
        return raw || null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadCachedGraph(repoRoot: string): CachedGraph {
  const file = join(repoRoot, GRAPH_REL);
  if (!existsSync(file)) {
    throw Object.assign(new Error(`ECS graph artifact missing at ${GRAPH_REL} (run npm run graphify:build)`), { status: 404 });
  }
  const st = statSync(file);
  const hit = cacheByRoot.get(repoRoot);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;

  const data = JSON.parse(readFileSync(file, "utf8")) as EcsGraphPayload;
  const objectsById = new Map<string, EcsGraphNode>();
  const coreNodes: EcsGraphNode[] = [];
  for (const n of data.nodes) {
    if (n.kind === "object") objectsById.set(n.id.replace(/^object:/, ""), n);
    else coreNodes.push(n);
  }
  const instantiatesByObjectId = new Map<string, EcsGraphEdge[]>();
  const coreEdges: EcsGraphEdge[] = [];
  for (const e of data.edges) {
    if (e.kind === "instantiates" && e.from.startsWith("object:")) {
      const key = e.from.slice("object:".length);
      const list = instantiatesByObjectId.get(key) ?? [];
      list.push(e);
      instantiatesByObjectId.set(key, list);
    } else {
      coreEdges.push(e);
    }
  }
  const entry: CachedGraph = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    data,
    coreNodes,
    coreEdges,
    objectsById,
    instantiatesByObjectId,
  };
  cacheByRoot.set(repoRoot, entry);
  return entry;
}

export function readEcsGraphSlice(
  repoRoot: string,
  options: { objectId?: string | null; full?: boolean } = {},
): EcsGraphPayload {
  const cached = loadCachedGraph(repoRoot);
  const currentHead = resolveRepoHead(repoRoot);
  if (options.full) {
    return { meta: cached.data.meta, currentHead, nodes: cached.data.nodes, edges: cached.data.edges };
  }
  const nodes = [...cached.coreNodes];
  const edges = [...cached.coreEdges];
  if (options.objectId) {
    const objNode = cached.objectsById.get(options.objectId);
    if (objNode) nodes.push(objNode);
    const objEdges = cached.instantiatesByObjectId.get(options.objectId);
    if (objEdges) edges.push(...objEdges);
  }
  return { meta: cached.data.meta, currentHead, nodes, edges };
}

/** Handle `GET /api/editor/graph[?object=<id>&full=1]`. Returns null if unrelated URL. */
export function handleGraphRoute(repoRoot: string, method: string, urlString: string): RouteReply | null {
  const parsed = new URL(urlString, "http://localhost");
  if (parsed.pathname !== "/api/editor/graph") return null;
  if (method !== "GET") {
    return { status: 405, body: { ok: false, error: "GET only" } };
  }
  try {
    const full = parsed.searchParams.get("full") === "1";
    const objectId = parsed.searchParams.get("object");
    const graph = readEcsGraphSlice(repoRoot, { objectId, full });
    return { status: 200, body: { ok: true, graph } };
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return { status, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
  }
}
