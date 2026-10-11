/**
 * Flow node context menu operations: rename, duplicate.
 * Pure functions over FlowDoc; the flow editor wires them to the
 * context menu and the history stack.
 */
import type { FlowDoc } from "@mmo-engine/scene";

export type { FlowDoc };

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function freshId(doc: FlowDoc, base: string): string {
  let id = `${base}-copy`;
  let n = 2;
  while (id in doc.nodes) id = `${base}-copy-${n++}`;
  return id;
}

/**
 * Rename a node: the node, its edges, and the start pointer follow.
 * Throws on missing node, empty id, or id collision.
 */
export function renameFlowNode(doc: FlowDoc, id: string, next: string): FlowDoc {
  const node = doc.nodes[id];
  if (!node) throw new Error(`flow node "${id}" not found`);
  const name = next.trim();
  if (!name) throw new Error("flow node id cannot be empty");
  if (name !== id && name in doc.nodes) throw new Error(`flow node "${name}" already exists`);
  if (!ID_RE.test(name)) throw new Error(`invalid flow node id "${name}"`);
  const nodes: FlowDoc["nodes"] = {};
  for (const [k, v] of Object.entries(doc.nodes)) nodes[k === id ? name : k] = v;
  return {
    ...doc,
    start: doc.start === id ? name : doc.start,
    nodes,
    edges: doc.edges.map((e) => ({
      ...e,
      from: e.from === id ? name : e.from,
      to: e.to === id ? name : e.to,
    })),
  };
}

/** Duplicate a node with a fresh id, offset down-right. Edges are not copied. */
export function duplicateFlowNode(doc: FlowDoc, id: string): FlowDoc {
  const node = doc.nodes[id];
  if (!node) throw new Error(`flow node "${id}" not found`);
  const copyId = freshId(doc, id);
  return {
    ...doc,
    nodes: {
      ...doc.nodes,
      [copyId]: { ...node, x: (node.x ?? 0) + 40, y: (node.y ?? 0) + 40 },
    },
  };
}
