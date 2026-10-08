/**
 * Game flow (roadmap EA7, EDITOR-ARCHITECTURE.md section 6): a graph of
 * scenes (client screens) and the event-driven transitions between them,
 * stored in `content/flow/game.flow.json`. Pure: the client runs it with
 * `flowStep`, the editor edits it with the ops below and validates it with
 * `validateFlow`. Edit ops return new documents.
 */
import type { SceneIssue } from "./index.js";

export const FLOW_VERSION = 1;
/** The world node's scene: whatever the server assigns. */
export const ASSIGNED_SCENE = "@assigned";
/** Frontend scenes the client ships. */
export const BUILTIN_SCREENS: readonly string[] = ["login", "loading", "character-select", "character-creation"];
/** Events the client raises: the protocol's replies and the screens' own buttons. */
export const FLOW_EVENTS: readonly string[] = [
  "ui.submit", // login form submitted
  "ui.create", // character screen: new character
  "ui.select", // character screen: back to the list
  "net.account", // handshake answered with the account's characters
  "net.welcome", // handshake went straight into the world (token rejoin)
  "net.joinReply.ok", // entered the world as a character
  "net.error", // handshake failed
  "net.closed", // connection closed
];

export interface FlowNode {
  /** A scene name, or "@assigned" for the server-assigned world. */
  scene: string;
  /** Editor layout only. */
  x?: number;
  y?: number;
}
export interface FlowEdge {
  from: string;
  on: string;
  to: string;
}
export interface FlowDoc {
  version: number;
  start: string;
  nodes: Record<string, FlowNode>;
  edges: FlowEdge[];
}

const NODE_RE = /^[a-z0-9][a-z0-9-]*$/;

/** `scenes`: scene names that exist (built-in screens are always allowed). Omit to skip the check. */
export function validateFlow(doc: unknown, opts: { scenes?: readonly string[] } = {}): SceneIssue[] {
  const issues: SceneIssue[] = [];
  const add = (path: string, message: string): void => void issues.push({ path, message });
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return [{ path: "", message: "flow must be an object" }];
  const d = doc as Partial<FlowDoc>;
  if (d.version !== FLOW_VERSION) add("version", `must be ${FLOW_VERSION}`);
  const nodes = typeof d.nodes === "object" && d.nodes !== null && !Array.isArray(d.nodes) ? d.nodes : null;
  if (!nodes) add("nodes", "must be an object");
  const ids = nodes ? Object.keys(nodes) : [];
  const known = opts.scenes ? new Set([...BUILTIN_SCREENS, ASSIGNED_SCENE, ...opts.scenes]) : null;
  for (const id of ids) {
    if (!NODE_RE.test(id)) add(`nodes.${id}`, "id must be lowercase letters, digits and dashes");
    const n = (nodes as Record<string, FlowNode>)[id];
    if (typeof n !== "object" || n === null || typeof n.scene !== "string" || n.scene === "") add(`nodes.${id}.scene`, "needs a scene name");
    else if (known && !known.has(n.scene)) add(`nodes.${id}.scene`, `unknown scene "${n.scene}"`);
  }
  const startOk = typeof d.start === "string" && ids.includes(d.start);
  if (!startOk) add("start", `start node "${String(d.start)}" does not exist`);
  if (!Array.isArray(d.edges)) add("edges", "must be an array");
  else {
    const seen = new Set<string>();
    d.edges.forEach((e, i) => {
      if (typeof e !== "object" || e === null) return add(`edges.${i}`, "must be an object");
      if (!ids.includes(e.from)) add(`edges.${i}.from`, `dangling: node "${String(e.from)}" does not exist`);
      if (!ids.includes(e.to)) add(`edges.${i}.to`, `dangling: node "${String(e.to)}" does not exist`);
      if (!FLOW_EVENTS.includes(e.on)) add(`edges.${i}.on`, `unknown event "${String(e.on)}"`);
      const k = `${e.from}|${e.on}`;
      if (seen.has(k)) add(`edges.${i}`, `node "${e.from}" already has a transition on "${e.on}"`);
      seen.add(k);
    });
  }
  if (startOk && Array.isArray(d.edges)) {
    const reach = flowReachable(d as FlowDoc);
    for (const id of ids) if (!reach.has(id)) add(`nodes.${id}`, "unreachable from the start node");
  }
  return issues;
}

/** Nodes reachable from start. */
export function flowReachable(doc: FlowDoc): Set<string> {
  const seen = new Set<string>();
  const queue = doc.start in doc.nodes ? [doc.start] : [];
  while (queue.length) {
    const cur = queue.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of doc.edges ?? []) if (e && e.from === cur && e.to in doc.nodes) queue.push(e.to);
  }
  return seen;
}

/** The node an event leads to from `node`; `node` itself when no edge matches. */
export function flowStep(doc: FlowDoc, node: string, event: string): string {
  return doc.edges.find((e) => e.from === node && e.on === event)?.to ?? node;
}

/** Shortest event sequence from start to `target` (null when unreachable or unknown). Used by Play from a node. */
export function flowEventsTo(doc: FlowDoc, target: string): string[] | null {
  if (!(target in doc.nodes) || !(doc.start in doc.nodes)) return null;
  const prev = new Map<string, { from: string; on: string }>();
  const queue = [doc.start];
  const seen = new Set(queue);
  while (queue.length) {
    const cur = queue.shift() as string;
    if (cur === target) break;
    for (const e of doc.edges) {
      if (e.from !== cur || seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, { from: cur, on: e.on });
      queue.push(e.to);
    }
  }
  if (!seen.has(target)) return null;
  const out: string[] = [];
  for (let n = target; n !== doc.start; ) {
    const p = prev.get(n) as { from: string; on: string };
    out.unshift(p.on);
    n = p.from;
  }
  return out;
}

export const addFlowNode = (doc: FlowDoc, id: string, node: FlowNode): FlowDoc => ({ ...doc, nodes: { ...doc.nodes, [id]: node } });
export function removeFlowNode(doc: FlowDoc, id: string): FlowDoc {
  const nodes = { ...doc.nodes };
  delete nodes[id];
  return { ...doc, nodes, edges: doc.edges.filter((e) => e.from !== id && e.to !== id) };
}
export const addFlowEdge = (doc: FlowDoc, edge: FlowEdge): FlowDoc => ({ ...doc, edges: [...doc.edges, edge] });
export const removeFlowEdge = (doc: FlowDoc, index: number): FlowDoc => ({ ...doc, edges: doc.edges.filter((_, i) => i !== index) });
export const rewireFlowEdge = (doc: FlowDoc, index: number, to: string): FlowDoc => ({
  ...doc,
  edges: doc.edges.map((e, i) => (i === index ? { ...e, to } : e)),
});
export const setFlowStart = (doc: FlowDoc, start: string): FlowDoc => ({ ...doc, start });
export const moveFlowNode = (doc: FlowDoc, id: string, x: number, y: number): FlowDoc => ({
  ...doc,
  nodes: { ...doc.nodes, [id]: { ...doc.nodes[id], x, y } },
});
