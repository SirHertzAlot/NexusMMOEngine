/**
 * Copying scene nodes for paste and duplicate: the copy and every node
 * under it get ids the document doesn't use yet, so a pasted subtree never
 * collides with the original or with itself.
 */

import type { SceneNode } from "@mmo-engine/scene";

function collectIds(nodes: readonly SceneNode[], into: Set<string>): Set<string> {
  for (const n of nodes) {
    into.add(n.id);
    if (n.children) collectIds(n.children, into);
  }
  return into;
}

/** A deep copy of `node` whose ids (its own and its descendants') are all new to `doc`. */
export function withFreshIds(doc: { nodes: readonly SceneNode[] }, node: SceneNode, base = "node"): SceneNode {
  const used = collectIds(doc.nodes, new Set());
  let i = 1;
  const fresh = (): string => {
    while (used.has(`${base}-${i}`)) i++;
    const id = `${base}-${i}`;
    used.add(id);
    return id;
  };
  const copy = (n: SceneNode): SceneNode => ({
    ...structuredClone(n),
    id: fresh(),
    children: n.children?.map(copy),
  });
  return copy(node);
}

/** The id of the node holding `id`, or null when it sits at the top level (or isn't there). */
export function parentIdOf(doc: { nodes: readonly SceneNode[] }, id: string): string | null {
  const walk = (nodes: readonly SceneNode[]): string | null => {
    for (const n of nodes) {
      if (n.children?.some((c) => c.id === id)) return n.id;
      const deeper = n.children ? walk(n.children) : null;
      if (deeper !== null) return deeper;
    }
    return null;
  };
  return walk(doc.nodes);
}
