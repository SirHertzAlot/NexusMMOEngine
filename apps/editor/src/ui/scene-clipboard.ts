/**
 * Copy / cut / paste / duplicate for scene nodes (Edit menu, Scenes panel).
 *
 * The clipboard holds a deep copy of one node and its children. Pasting
 * gives the copy (and every descendant) ids that are free in the target
 * document, so the scene stays valid; the panel applies it through the
 * scene command stack, so one Undo takes the paste back.
 */

import { findNode, type SceneDoc, type SceneNode } from "@mmo-engine/scene";

let clip: SceneNode | null = null;

export const clipboardNode = (): SceneNode | null => clip;
export const clearClipboard = (): void => {
  clip = null;
};

export function copyNode(doc: SceneDoc, id: string): boolean {
  const n = findNode(doc, id);
  if (!n) return false;
  clip = structuredClone(n);
  return true;
}

function allIds(list: SceneNode[], into = new Set<string>()): Set<string> {
  for (const n of list) {
    into.add(n.id);
    allIds(n.children ?? [], into);
  }
  return into;
}

/** `node` and its descendants renamed to ids not in `used` (`goblin` -> `goblin-2`); `used` gains the new ids. */
export function withFreshIds(node: SceneNode, used: Set<string>): SceneNode {
  const base = node.id.replace(/-\d+$/, "");
  let id = node.id;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  used.add(id);
  const copy: SceneNode = { ...structuredClone({ ...node, children: undefined }), id };
  if (node.children) copy.children = node.children.map((c) => withFreshIds(c, used));
  else delete copy.children;
  return copy;
}

/** The clipboard's node ready to add to `doc` (fresh ids), or null when the clipboard is empty. */
export function pasteCandidate(doc: SceneDoc): SceneNode | null {
  return clip ? withFreshIds(clip, allIds(doc.nodes)) : null;
}

/** A copy of node `id` with fresh ids, for Duplicate. */
export function duplicateCandidate(doc: SceneDoc, id: string): SceneNode | null {
  const n = findNode(doc, id);
  return n ? withFreshIds(n, allIds(doc.nodes)) : null;
}
