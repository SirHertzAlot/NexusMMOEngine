/**
 * Cooker — compiles a `.pcg.json` graph (+ optional instance overrides)
 * into a versioned, hashed, execution-ordered ScatterPlan.
 *
 * Pipeline: structural parse (schema.ts) → param resolution → per-node
 * settings validation (pre/post, nodes.ts) → DAG validation (pin rules,
 * reachability, cycle check) → topological order → canonical hash.
 *
 * The CookedPlan is the build artifact the runtime (C++ scatter addon,
 * slice 3) executes. Same graph + same params → same hash, always.
 * Cooking is offline/authoring-time only.
 */
import { createHash } from "node:crypto";
import {
  isParamRef,
  type PcGraph,
  type PcInstance,
  type PcParam,
} from "./schema.js";
import { getNodeType, validateSettings } from "./nodes.js";

export interface ResolvedNode {
  id: string;
  type: string;
  /** Settings with all `{ $param }` refs substituted (literals only). */
  settings: Record<string, unknown>;
}

export interface CookedPlan {
  planVersion: 1;
  graphName: string;
  /**
   * sha256 hex of the canonical (graph name + resolved params + resolved
   * nodes + edges) document. Plan identity: the runtime caches and
   * versions cooked plans by this hash, like navmesh tiles.
   */
  hash: string;
  /** Fully resolved parameters (defaults + instance overrides). */
  params: Record<string, number | string | boolean>;
  /** Nodes in execution (topological) order. */
  nodes: ResolvedNode[];
  /** Node ids in execution order (== nodes.map(n => n.id)). */
  order: string[];
  /** Terminal spawner node id. */
  spawner: string;
}

/** Deterministic JSON: object keys sorted recursively. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

function resolveParams(
  declared: PcParam[],
  instance?: PcInstance,
): Record<string, number | string | boolean> {
  const resolved: Record<string, number | string | boolean> = {};
  for (const p of declared) {
    if (typeof p.default !== p.type) {
      throw new Error(
        `param "${p.name}" declares type ${p.type} but its default is ${typeof p.default}`,
      );
    }
    resolved[p.name] = p.default;
  }
  if (instance) {
    for (const [name, value] of Object.entries(instance.params)) {
      const decl = declared.find((p) => p.name === name);
      if (!decl) throw new Error(`instance overrides unknown param "${name}"`);
      if (typeof value !== decl.type) {
        throw new Error(
          `instance param "${name}" must be ${decl.type}, got ${typeof value}`,
        );
      }
      resolved[name] = value;
    }
  }
  return resolved;
}

function substituteParamRefs(
  nodeId: string,
  settings: Record<string, unknown>,
  params: Record<string, number | string | boolean>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (isParamRef(value)) {
      const name = value.$param;
      if (!(name in params)) {
        throw new Error(
          `node "${nodeId}" setting "${key}" references unknown param "${name}"`,
        );
      }
      out[key] = params[name];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function cook(graph: PcGraph, instance?: PcInstance): CookedPlan {
  if (instance && instance.graph !== graph.name) {
    throw new Error(
      `instance targets graph "${instance.graph}" but got "${graph.name}"`,
    );
  }

  const params = resolveParams(graph.params, instance);

  // -- node ids unique, types known -------------------------------------
  const seen = new Set<string>();
  for (const n of graph.nodes) {
    if (seen.has(n.id)) throw new Error(`duplicate node id "${n.id}"`);
    seen.add(n.id);
    if (!getNodeType(n.type)) {
      throw new Error(`node "${n.id}" has unknown type "${n.type}"`);
    }
  }

  // -- resolve + validate settings --------------------------------------
  const resolved = new Map<string, ResolvedNode>();
  for (const n of graph.nodes) {
    const def = getNodeType(n.type)!;
    const pre = validateSettings(def, n.settings, "pre");
    const substituted = substituteParamRefs(n.id, pre, params);
    const post = validateSettings(def, substituted, "post");
    resolved.set(n.id, { id: n.id, type: n.type, settings: post });
  }

  // -- edges -------------------------------------------------------------
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  for (const id of seen) {
    succ.set(id, []);
    pred.set(id, []);
  }
  for (const e of graph.edges) {
    if (!seen.has(e.from)) throw new Error(`edge from unknown node "${e.from}"`);
    if (!seen.has(e.to)) throw new Error(`edge to unknown node "${e.to}"`);
    if (e.from === e.to) throw new Error(`node "${e.from}" has a self-edge`);
    succ.get(e.from)!.push(e.to);
    pred.get(e.to)!.push(e.from);
  }

  // -- pin rules ----------------------------------------------------------
  const spawners: string[] = [];
  const samplers: string[] = [];
  for (const n of graph.nodes) {
    const def = getNodeType(n.type)!;
    const indeg = pred.get(n.id)!.length;
    if (def.category === "sampler") {
      samplers.push(n.id);
      if (indeg !== 0)
        throw new Error(`sampler node "${n.id}" must have no inputs`);
    } else if (indeg !== 1) {
      throw new Error(
        `node "${n.id}" (${n.type}) must have exactly one input, got ${indeg}`,
      );
    }
    if (def.terminal) spawners.push(n.id);
  }
  if (spawners.length === 0) throw new Error("graph has no spawner node");
  if (spawners.length > 1)
    throw new Error(
      `v1 graphs support exactly one spawner, got ${spawners.length}: ${spawners.join(", ")}`,
    );
  if (samplers.length !== 1)
    throw new Error(
      `v1 graphs support exactly one sampler, got ${samplers.length}`,
    );
  const spawner = spawners[0];

  // -- every node must lie on a sampler→spawner path ----------------------
  const forward = new Set<string>();
  const fstack = [...samplers];
  while (fstack.length) {
    const id = fstack.pop()!;
    if (forward.has(id)) continue;
    forward.add(id);
    fstack.push(...succ.get(id)!);
  }
  const backward = new Set<string>([spawner]);
  const bstack = [...pred.get(spawner)!];
  while (bstack.length) {
    const id = bstack.pop()!;
    if (backward.has(id)) continue;
    backward.add(id);
    bstack.push(...pred.get(id)!);
  }
  for (const id of seen) {
    if (!forward.has(id) || !backward.has(id)) {
      throw new Error(
        `node "${id}" is not on a sampler→spawner path (dead branch or disconnected)`,
      );
    }
  }

  // -- topological order (Kahn); a cycle here is a cooker bug guard --------
  const indeg = new Map<string, number>();
  for (const id of seen) indeg.set(id, pred.get(id)!.length);
  const queue: string[] = [...seen].filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    // deterministic: always expand the lexicographically smallest id
    queue.sort();
    const id = queue.shift()!;
    order.push(id);
    for (const s of succ.get(id)!) {
      indeg.set(s, indeg.get(s)! - 1);
      if (indeg.get(s) === 0) queue.push(s);
    }
  }
  if (order.length !== seen.size) {
    throw new Error("graph contains a cycle");
  }

  const nodes = order.map((id) => resolved.get(id)!);
  const hash = createHash("sha256")
    .update(
      stableStringify({
        graph: graph.name,
        params,
        nodes,
        edges: [...graph.edges]
          .map((e) => [e.from, e.to] as [string, string])
          .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)),
      }),
    )
    .digest("hex");

  return { planVersion: 1, graphName: graph.name, hash, params, nodes, order, spawner };
}
